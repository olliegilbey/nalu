import { TRPCError } from "@trpc/server";
import { escapeXmlText } from "@/lib/security/escapeXmlText";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { SCOPING } from "@/lib/config/tuning";
import { parseFrameworkResponse } from "./parsers";
import type { ClarificationJsonb, FrameworkJsonb } from "@/lib/types/jsonb";
import type { Framework } from "@/lib/prompts/framework";

/** Parameters for {@link generateFramework}. Object shape keeps callers future-proof. */
export interface GenerateFrameworkParams {
  /** Course primary key. */
  readonly courseId: string;
  /** Must match `course.userId` — scoped to prevent cross-user access. */
  readonly userId: string;
  /**
   * The learner's clarification answers, one per question (by position).
   * Supplied by the router from the client request — NOT read from the DB
   * (clarify stores answers as `[]` pending this step). Each answer is
   * sanitised via `escapeXmlText` before being embedded in the LLM prompt.
   */
  readonly answers: readonly string[];
}

/**
 * Result of a framework-generation turn.
 *
 * Returns `FrameworkJsonb` (snake_case, storage shape) directly rather than
 * the camelCase `Framework` from the parser. This avoids a reverse translator:
 * the stored shape is what callers (baseline step, wave seeding) ultimately need.
 */
export interface GenerateFrameworkResult {
  readonly framework: FrameworkJsonb;
  readonly nextStage: "baseline";
}

/**
 * Drive the framework-generation step of scoping (PRD §4.1 step 2).
 *
 * Pattern mirrors `clarify`:
 *   fetch course (with ownership guard)
 *   → precondition checks (status='scoping', clarification present)
 *   → idempotency: return stored FrameworkJsonb if already populated
 *   → open/reuse scoping pass
 *   → executeTurn(seed=scoping, parser=parseFrameworkResponse)
 *   → translate Framework (camelCase) → FrameworkJsonb (snake_case) and persist
 *   → return { framework: FrameworkJsonb, nextStage: "baseline" }
 */
export async function generateFramework(
  params: GenerateFrameworkParams,
): Promise<GenerateFrameworkResult> {
  // Input guards — checked before any DB call to fail fast on bad input.
  if (params.answers.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "answers cannot be empty" });
  }
  if (params.answers.length > SCOPING.maxClarifyAnswers) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `at most ${SCOPING.maxClarifyAnswers} answers allowed`,
    });
  }

  const course = await getCourseById(params.courseId, params.userId);

  // Precondition: only valid during scoping phase.
  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateFramework: course ${course.id} is in status '${course.status}', expected 'scoping'`,
    });
  }

  // Precondition: clarification must exist — we need its questions.length for
  // the strict-length guard below.
  if (course.clarification === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateFramework: course ${course.id} has no clarification — run clarify first`,
    });
  }

  const clarification = course.clarification as ClarificationJsonb;

  // Strict length-match: one answer per question, no more, no less.
  // Mismatches indicate a client/router bug, not a user input error, so
  // BAD_REQUEST surfaces it immediately rather than silently padding/truncating.
  if (params.answers.length !== clarification.questions.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `answers length (${params.answers.length}) must match questions length (${clarification.questions.length})`,
    });
  }

  // Idempotency: if framework already stored, return it without re-prompting.
  // Drizzle infers `jsonb` columns as `unknown`; `courseRowGuard` (called inside
  // `getCourseById`) has already validated the payload against `frameworkJsonbSchema`,
  // so the cast narrows a runtime-guaranteed shape to its TS type without re-parsing.
  if (course.framework !== null) {
    return {
      framework: course.framework as FrameworkJsonb,
      nextStage: "baseline",
    };
  }

  // Per spec §3.4, the user message in the framework turn is the bare <answers>
  // array — questions are already in the conversation history from the prior
  // clarify turn, and stage instructions live in the system prompt rendered by
  // `renderScopingSystem`. Topic duplication is also unnecessary (already in the
  // seed's <scoping_topic> tag). Answers are XML-escaped before embedding since
  // they are untrusted caller input.
  const sanitisedAnswers = params.answers.map((a) => escapeXmlText(a));
  const userContent = `<answers>${JSON.stringify(sanitisedAnswers)}</answers>`;

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: userContent,
    parser: parseFrameworkResponse,
    label: "framework",
    successSummary: (p) =>
      `tiers=${p.framework.tiers.length} startTier=${p.framework.estimatedStartingTier}`,
  });

  // Translate camelCase Framework → snake_case FrameworkJsonb before persisting.
  // `updateCourseScopingState` validates against `frameworkJsonbSchema` before writing.
  const jsonb = toFrameworkJsonb(parsed.framework, course.topic);
  await updateCourseScopingState(course.id, { framework: jsonb });

  return { framework: jsonb, nextStage: "baseline" };
}

/**
 * Translate the camelCase `Framework` (parser output) to the snake_case
 * `FrameworkJsonb` required by `courses.framework` column schema.
 *
 * Also injects two fields that live in the storage schema but are absent from
 * the parser type:
 *   - `topic`: the course topic, threaded from the caller.
 *   - `scope_summary`: a synthesised placeholder. No production code reads
 *     this field today (confirmed by grep: only `jsonb.ts` schema and test
 *     fixtures reference it). Future wave-seeding may bind `topicScope` from
 *     it. The placeholder is defensible and can be replaced by an explicit
 *     producer when a consumer appears.
 */
function toFrameworkJsonb(framework: Framework, topic: string): FrameworkJsonb {
  return {
    topic,
    // Synthesised stub pending an explicit producer — no consumer reads this today.
    scope_summary: `Baseline covers tiers ${framework.baselineScopeTiers.join(", ")}.`,
    estimated_starting_tier: framework.estimatedStartingTier,
    baseline_scope_tiers: framework.baselineScopeTiers,
    tiers: framework.tiers.map((t) => ({
      number: t.number,
      name: t.name,
      description: t.description,
      example_concepts: t.exampleConcepts,
    })),
  };
}
