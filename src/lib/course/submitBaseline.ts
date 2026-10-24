import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById } from "@/db/queries/courses";
import { updateCourseScopingState } from "@/db/queries/courses.scoping";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { getOpenWaveByCourse } from "@/db/queries/waves";
import { makeCloseTurnBaseSchema } from "@/lib/prompts/closeTurn";
import { renderScopingCloseStage } from "@/lib/prompts/scopingClose";
import {
  buildScopingCloseLearnerInput,
  requireQuestionTier,
  splitOne,
} from "./submitBaseline.internal";
import { scoreBaseline } from "@/lib/scoring/scoreBaseline";
import { logScopingCloseGradings } from "./closeGradingDebug";
import { persistScopingClose } from "./submitBaseline.persist";
import type { BaselineJsonb, FrameworkJsonb } from "@/lib/types/jsonb";
import type { QuestionnaireAnswer } from "@/lib/types/questionnaireAnswer";

/** Input to {@link submitBaseline}. */
export interface SubmitBaselineParams {
  readonly courseId: string;
  readonly userId: string;
  readonly answers: readonly QuestionnaireAnswer[];
}

/** Payload returned by {@link submitBaseline}. */
export interface SubmitBaselineResult {
  /** The model's closing-turn framing (the chat message the learner sees). */
  readonly userMessage: string;
  /** Newly-opened Wave 1 id — useful for the router's next redirect target. */
  readonly wave1Id: string;
  /**
   * Free-text baseline XP the client adds to the header badge on submit
   * success. Excludes MC XP — correct MC answers are scored instantly
   * client-side (`calculateMcXp`), so returning the full total would
   * double-count. Zero on an idempotent replay (see `buildCachedPayload`):
   * the XP was already persisted and surfaced on the original close.
   */
  readonly freeTextXpAwarded: number;
}

/**
 * Closing turn of scoping. Drives one append-only LLM call against the
 * existing scoping Context, validates against `makeCloseTurnBaseSchema`,
 * places the learner (`scoreBaseline` → `determineStartingTier`), and
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
  // Each question's id and tier, for placement. `splitOne` above already
  // threw on a question with no tier, so here the guard only narrows the type.
  const baselineQuestions = baseline.questions.map((q) => ({
    id: q.id,
    tier: requireQuestionTier(q),
  }));

  // Schema closed over runtime scope + question ids so refine messages name
  // the specific values that triggered any violation. The scoping close emits
  // the shared close-turn base and nothing more: deterministic code computes
  // the starting tier below (issue #94).
  //
  // freshConceptNames: all example concepts from the framework tiers (the
  // model may pick from these or introduce novel ones — validated loosely).
  // reviewDueNames / existingConceptNames: both empty at scoping close since
  // no concepts exist yet and SM-2 has no due entries pre-teaching.
  const freshConceptNames = framework.tiers.flatMap((t) => t.exampleConcepts);
  const schema = makeCloseTurnBaseSchema({
    scopeTiers,
    questionIds,
    freshConceptNames,
    reviewDueNames: [],
    existingConceptNames: [],
  });

  // Persist the learner's answers on the baseline row before calling the LLM,
  // so a retry does not lose them and `deriveChatEntries` can render the user-baseline
  // bubble from `baseline.responses`. Mirrors generateFramework.ts:86-92.
  // Idempotent: overwrites the empty `responses: []` initialised by generateBaseline.
  // The same Responses feed the issue #22 debug log after the close turn.
  const responses = params.answers.map((a) =>
    a.kind === "mc"
      ? { questionId: a.id, choice: a.selected }
      : { questionId: a.id, freetext: a.text },
  );
  // Concurrent-close recovery: two calls can both pass the precondition gate
  // above. Two tabs can race, or a reloaded tab's Retry can re-send while the
  // original Turn still runs. Whichever call commits its close first wins.
  // The loser fails at whichever step meets the winner's commit:
  //   - the answer write below (status-guarded: it skips a closed course),
  //   - `ensureOpenScopingPass` (the pass is closed, and a course has only one),
  //   - `executeTurn` (both reserved the same turn_index),
  //   - `persistScopingClose` (Wave 1 already open, or the baseline widened).
  // Rather than enumerate failure modes, we observe the post-failure state:
  // if status flipped to 'active', the winner finished; replay its cached
  // payload. Otherwise the failure is unrelated — re-throw. Token waste on the
  // loser is acknowledged; the alternative — row-locking across the LLM call
  // — would tie up a pooled connection for seconds at a time.
  try {
    await updateCourseScopingState(course.id, {
      baseline: {
        userMessage: baseline.userMessage,
        questions: baseline.questions,
        gradings: baseline.gradings,
        responses,
      },
    });

    // Idempotent under single-writer invariant; handles concurrent-writer race
    // via re-read on unique-violation.
    const pass = await ensureOpenScopingPass(course.id);

    // Learner-input payload carries raw answers + mechanical MC gradings so the
    // model doesn't waste tokens re-evaluating MC clicks. A typed MC answer
    // also carries its answer key (issue #149). The payload reaches only the
    // model's Context: `responses` above holds the raw answers.
    const learnerInput = buildScopingCloseLearnerInput({
      questions: baseline.questions,
      answers: params.answers,
      mechanicalGradings,
    });

    const { parsed } = await executeTurn({
      parent: { kind: "scoping", id: pass.id },
      seed: { kind: "scoping", topic: course.topic },
      // The envelope also states the placement rule, so the model pitches
      // Wave 1 at the tier `scoreBaseline` will compute below.
      userMessageContent: renderScopingCloseStage({ learnerInput, scopeTiers }),
      responseSchema: schema,
      responseSchemaName: "scoping_close",
      label: "scoping-close",
      successSummary: (p) => `gradings=${p.gradings.length}`,
    });

    // Defence-in-depth: the schema already enforced tier scope + id coverage,
    // but scoreBaseline re-checks at the orchestration layer so a future
    // schema regression surfaces as a thrown Error rather than corrupt XP.
    // It also places the learner: the starting tier comes from the graded
    // answers, never from the model (issue #94).
    //
    // Filter to free-text gradings only: mc-index gradings lack the full
    // StoredGrading shape (no conceptName/conceptTier/verdict/qualityScore).
    // Scoping baseline questions are all free-text anyway, but the type
    // must be narrowed here to satisfy the StoredGrading type at the
    // scoreBaseline boundary.
    const freeTextGradings = parsed.gradings.filter((g) => g.kind === "free-text");
    const merged = scoreBaseline({
      parsed: { gradings: freeTextGradings },
      mechanicalGradings,
      baselineQuestions,
      scopeTiers,
    });

    // Issue #22 diagnosis: no-op unless LLM_DEBUG_GRADINGS is on, and never
    // throws. Same lines as `executeWaveClose`: grading kind beside Response
    // kind, plus verdict, quality and XP for free-text gradings. It runs after
    // the merge because XP is scored at the computed starting tier.
    logScopingCloseGradings({
      gradings: parsed.gradings,
      responses,
      startingTier: merged.startingTier,
    });

    // persistScopingClose: widens baseline JSONB (overwriting userMessage with
    // the closing framing), closes the scoping pass, upserts concepts, opens
    // Wave 1, inserts the opening assistant message, flips status, bumps XP —
    // all in one transaction.
    const { wave1Id } = await persistScopingClose({
      courseId: course.id,
      scopingPassId: pass.id,
      parsed,
      merged,
    });
    return { userMessage: parsed.userMessage, wave1Id, freeTextXpAwarded: merged.freeTextXp };
  } catch (err) {
    return replayIfClosed(err, course.id, params.userId);
  }
}

/**
 * Recover from losing a race to a concurrent scoping close. If the course is
 * now active, the winner committed: return its persisted payload, via the
 * same path as the top-level idempotent replay. Otherwise rethrow `err`.
 */
async function replayIfClosed(
  err: unknown,
  courseId: string,
  userId: string,
): Promise<SubmitBaselineResult> {
  const refreshed = await getCourseById(courseId, userId);
  if (refreshed.status !== "active") throw err;
  return buildCachedPayload(refreshed.id, refreshed.baseline as BaselineJsonb | null);
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
  // freeTextXpAwarded is 0 on replay: this course already closed, its XP is
  // persisted, and the client's badge counter already absorbed it on the
  // original close. A non-zero value here would double-add on a retry.
  return { userMessage: baseline.userMessage, wave1Id: wave1.id, freeTextXpAwarded: 0 };
}
