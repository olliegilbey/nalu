import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { getCourseById } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { getOpenWaveByCourse } from "@/db/queries/waves";
import { makeScopingCloseSchema, renderScopingCloseStage } from "@/lib/prompts/scopingClose";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
import { splitOne, type BaselineAnswer } from "./submitBaseline.internal";
import { mergeAndComputeXp } from "@/lib/scoring/baselineMerge";
import { persistScopingClose } from "./submitBaseline.persist";
import type { BaselineJsonb, FrameworkJsonb } from "@/lib/types/jsonb";

/** Re-export the answer shape so callers (router) import it from one place. */
export type { BaselineAnswer } from "./submitBaseline.internal";

/** Input to {@link submitBaseline}. */
export interface SubmitBaselineParams {
  readonly courseId: string;
  readonly userId: string;
  readonly answers: readonly BaselineAnswer[];
}

/** Payload returned by {@link submitBaseline}. */
export interface SubmitBaselineResult {
  /** The model's closing-turn framing (the chat message the learner sees). */
  readonly userMessage: string;
  /** Newly-opened Wave 1 id — useful for the router's next redirect target. */
  readonly wave1Id: string;
}

/**
 * Closing turn of scoping. Drives one append-only LLM call against the
 * existing scoping Context, validates against `makeScopingCloseSchema`, and
 * persists everything atomically via {@link persistScopingClose}. After this
 * resolves, `course.status === 'active'` and Wave 1 is open with its
 * assistant `openingText` already in `context_messages` — no further LLM
 * call is needed to open Wave 1.
 *
 * Idempotency: a second call on an already-active course skips the LLM and
 * returns the persisted payload (the closing `userMessage` lives in the
 * widened `baseline` JSONB; Wave 1 id is recovered via `getOpenWaveByCourse`).
 *
 * Preconditions enforced before any LLM call: course is owned by `userId`,
 * status is `'scoping'` (or `'active'` for the replay path), both `framework`
 * and `baseline` JSONB are populated, and `answers` covers every question id.
 */
export async function submitBaseline(params: SubmitBaselineParams): Promise<SubmitBaselineResult> {
  const course = await getCourseById(params.courseId, params.userId);

  // Idempotent replay: already-active course returns the persisted payload
  // without re-running the LLM. `baseline` is typed `unknown` on the row but
  // `courseRowGuard` has Zod-validated it through `baselineJsonbSchema`, so
  // the cast is safe at this trust boundary (same pattern as generateBaseline).
  if (course.status === "active") {
    return buildCachedPayload(course.id, course.baseline as BaselineJsonb | null);
  }

  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `submitBaseline: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.framework === null || course.baseline === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `submitBaseline: course ${course.id} requires framework and baseline`,
    });
  }

  // Same trust-boundary cast as above — courseRowGuard already validated.
  const baseline = course.baseline as BaselineJsonb;
  // Defence-in-depth: status='scoping' with a closed baseline is impossible
  // (persistScopingClose flips status atomically). Fail loud, not silently.
  if ("startingTier" in baseline) {
    throw new Error(
      `submitBaseline: course ${course.id} has closed baseline but status='${course.status}'`,
    );
  }

  const framework = course.framework as FrameworkJsonb;
  const scopeTiers = framework.baselineScopeTiers;
  const questionIds = baseline.questions.map((q) => q.id);

  // Every baseline question must have exactly one matching answer. Missing,
  // duplicate, or unknown answer ids are all UI bugs (not LLM errors) and
  // each fails loud before any LLM call. Duplicates would otherwise collapse
  // silently via `Object.fromEntries` last-write-wins below.
  const knownQids = new Set(questionIds);
  const answerIdList = params.answers.map((a) => a.id);
  const answerIds = new Set(answerIdList);
  const missing = questionIds.filter((qid) => !answerIds.has(qid));
  if (missing.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `submitBaseline: missing answers for questions ${missing.join(", ")}`,
    });
  }
  const duplicates = answerIdList.filter((id, i) => answerIdList.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `submitBaseline: duplicate answers for questions ${[...new Set(duplicates)].join(", ")}`,
    });
  }
  const unknown = answerIdList.filter((id) => !knownQids.has(id));
  if (unknown.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `submitBaseline: answers for unknown questions ${unknown.join(", ")}`,
    });
  }

  // Mechanical MC grading: per question, either a deterministic MC grading
  // (no LLM) or a free-text item for the LLM to grade. The model still sees
  // the MC gradings in learnerInput so it can reference them in the closing
  // summary without re-grading them.
  const answerById = Object.fromEntries(params.answers.map((a) => [a.id, a] as const));
  const splits = baseline.questions.map((q) => {
    // Non-null assertion safe: we just verified every qid is in `answerIds`.
    const answer = answerById[q.id];
    if (!answer) {
      throw new Error(`submitBaseline: missing answer for ${q.id} after coverage check`);
    }
    return splitOne(q, answer);
  });
  const mechanicalGradings = splits.flatMap((s) => (s.kind === "mechanical" ? [s.grading] : []));

  // Schema closed over runtime scope + question ids so refine messages name
  // the specific values that triggered any violation. Wire-side JSON schema
  // only inlined for non-strict-mode models (see modelCapabilities).
  const schema = makeScopingCloseSchema({ scopeTiers, questionIds });
  const modelName = process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);
  const schemaJson = toSchemaJsonString(schema, { name: "scoping_close" });

  // Idempotent under single-writer invariant; handles concurrent-writer race
  // via re-read on unique-violation.
  const pass = await ensureOpenScopingPass(course.id);

  // Learner-input payload carries raw answers + mechanical MC gradings so the
  // model doesn't waste tokens re-evaluating MC clicks.
  const learnerInput = JSON.stringify({ answers: params.answers, mechanicalGradings });

  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderScopingCloseStage({
      learnerInput,
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
    }),
    responseSchema: schema,
    responseSchemaName: "scoping_close",
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "scoping-close",
    successSummary: (p) => `gradings=${p.gradings.length} startingTier=${p.startingTier}`,
  });

  // Defence-in-depth: the schema already enforced tier scope + id coverage,
  // but mergeAndComputeXp re-checks at the orchestration layer so a future
  // schema regression surfaces as a thrown Error rather than corrupt XP.
  const merged = mergeAndComputeXp({
    parsed: { gradings: parsed.gradings, startingTier: parsed.startingTier },
    mechanicalGradings,
    baselineQuestionIds: questionIds,
    scopeTiers,
  });

  // persistScopingClose: widens baseline JSONB (overwriting userMessage with
  // the closing framing), upserts concepts, opens Wave 1, inserts the opening
  // assistant message, flips status, bumps XP — all in one transaction.
  const { wave1Id } = await persistScopingClose({
    courseId: course.id,
    parsed,
    merged,
  });

  return { userMessage: parsed.userMessage, wave1Id };
}

/**
 * Build the cached payload for an already-active course.
 *
 * The closing `userMessage` is read from `baseline.userMessage` — which
 * `persistScopingClose` overwrites with the model's closing-turn framing on
 * close (see persist.ts §2). Wave 1 id is recovered by looking up the single
 * open Wave for this course; an active course must have exactly one.
 */
async function buildCachedPayload(
  courseId: string,
  baseline: BaselineJsonb | null,
): Promise<SubmitBaselineResult> {
  // Active status implies the closed-shape baseline; anything else means a
  // previous transaction half-committed — fail loud rather than return stale.
  if (baseline === null || !("startingTier" in baseline)) {
    throw new Error(`submitBaseline: 'active' course ${courseId} missing closed baseline JSONB`);
  }
  const wave1 = await getOpenWaveByCourse(courseId);
  if (!wave1) {
    throw new Error(`submitBaseline: 'active' course ${courseId} has no open Wave 1`);
  }
  return { userMessage: baseline.userMessage, wave1Id: wave1.id };
}
