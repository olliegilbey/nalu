import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { parseBaselineResponse } from "./parsers";
import { baselineSchema } from "@/lib/prompts/baseline";
import type { FrameworkJsonb, BaselineJsonb } from "@/lib/types/jsonb";
import type { BaselineAssessment } from "@/lib/prompts/baseline";

/** Parameters for {@link generateBaseline}. Object shape keeps callers future-proof. */
export interface GenerateBaselineParams {
  /** Course primary key. */
  readonly courseId: string;
  /** Must match `course.userId` — scoped to prevent cross-user access. */
  readonly userId: string;
}

/**
 * Result of a baseline-generation turn.
 *
 * `nextStage: "answering"` signals the router to move the learner into
 * the answer-collection phase (spec §4.1 step 3).
 */
export interface GenerateBaselineResult {
  readonly baseline: BaselineAssessment;
  readonly nextStage: "answering";
}

/**
 * Drive the baseline-generation step of scoping (PRD §4.1 step 3).
 *
 * Pattern mirrors `generateFramework`:
 *   fetch course (with ownership guard)
 *   → precondition checks (status='scoping', clarification + framework present)
 *   → idempotency: return stored baseline (re-parsed) if already populated
 *   → open/reuse scoping pass
 *   → executeTurn(seed=scoping, parser=parseBaselineResponse with scopeTiers)
 *   → translate BaselineAssessment → BaselineJsonb (adds empty answers/gradings) and persist
 *   → return { baseline, nextStage: "answering" }
 */
export async function generateBaseline(
  params: GenerateBaselineParams,
): Promise<GenerateBaselineResult> {
  const course = await getCourseById(params.courseId, params.userId);

  // Precondition: only valid during scoping phase.
  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateBaseline: course ${course.id} is in status '${course.status}', expected 'scoping'`,
    });
  }

  // Precondition: both clarification and framework must exist — baseline generation
  // follows both steps. A single condition mirrors the plan's §12 guard.
  if (course.clarification === null || course.framework === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateBaseline: course ${course.id} requires both clarification and framework — run clarify and generateFramework first`,
    });
  }

  // Idempotency: if baseline already stored, re-parse and return it without re-prompting.
  // WHY re-parse instead of cast: `baselineJsonbSchema` stores questions as `z.unknown[]`
  // (intentionally opaque after grading). A bare cast to `BaselineAssessment` would be
  // unsafe; `baselineSchema.parse` recovers the typed shape from the raw stored questions.
  if (course.baseline !== null) {
    const stored = course.baseline as BaselineJsonb;
    const baseline = baselineSchema.parse({ questions: stored.questions });
    return { baseline, nextStage: "answering" };
  }

  // Read baseline_scope_tiers from the stored FrameworkJsonb (snake_case storage shape).
  // The plan skeleton incorrectly used camelCase `framework.baselineScopeTiers` — wrong.
  const framework = course.framework as FrameworkJsonb;
  const scopeTiers = framework.baseline_scope_tiers;

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    // Per spec §3.4, the user message is a simple stage request — stage instructions
    // live in the system prompt rendered by `renderScopingSystem` (Task 15 wires that).
    userMessageContent: "<request>generate baseline</request>",
    // Bind scopeTiers into the parser closure so the parser can enforce the invariant
    // that every question's tier is within the framework's baseline scope.
    parser: (raw: string) => parseBaselineResponse(raw, { scopeTiers }),
  });

  // Persist via translator: BaselineAssessment has only `questions`; the JSONB storage
  // shape requires `answers` and `gradings` initialised to [] (populated in later steps).
  // `updateCourseScopingState` validates against `baselineJsonbSchema` before writing.
  await updateCourseScopingState(course.id, {
    baseline: toBaselineJsonb(parsed.baseline),
  });

  return { baseline: parsed.baseline, nextStage: "answering" };
}

/**
 * Translate parser output (`BaselineAssessment`) to `courses.baseline` JSONB shape.
 *
 * The parser only emits questions; `answers` and `gradings` are populated in
 * subsequent scoping steps (answering and grading). Initialise both to `[]`
 * so `baselineJsonbSchema.parse` inside `updateCourseScopingState` accepts the payload.
 */
function toBaselineJsonb(b: BaselineAssessment): BaselineJsonb {
  return { questions: b.questions, answers: [], gradings: [] };
}
