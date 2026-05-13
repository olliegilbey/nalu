import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { gradeBaselineSchema } from "@/lib/prompts/baselineGrading";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { BaselineJsonb } from "@/lib/types/jsonb";
import { baselineGradingSchema } from "@/lib/types/jsonb";
import type { LlmUsage } from "@/lib/types/llm";
import type { McOptionKey } from "@/lib/prompts/questionnaire";
import { splitOne, ZERO_USAGE } from "./gradeBaseline.internal";

export type BaselineAnswer =
  | { readonly id: string; readonly kind: "mc"; readonly selected: McOptionKey }
  | {
      readonly id: string;
      readonly kind: "freetext";
      readonly text: string;
      readonly fromEscape: boolean;
    };

export interface GradeBaselineParams {
  readonly courseId: string;
  readonly userId: string;
  readonly answers: readonly BaselineAnswer[];
}

export interface GradeBaselineResult {
  readonly gradings: readonly z.infer<typeof baselineGradingSchema>[];
  readonly usage: LlmUsage;
}

/**
 * Drive the baseline-grading turn.
 *
 * Pattern (spec §4.9): course fetch → preconditions → idempotency →
 * mechanical MC pass (no LLM) → if any non-MC answers, executeTurn with
 * `gradeBaselineSchema` → merge → persist `courses.baseline.gradings`.
 *
 * The all-MC shortcut (no LLM call when every answer is an MC click) is
 * preserved verbatim from the legacy implementation — same byId lookup,
 * same mechanical grader (`gradeMc` in `gradeBaseline.internal.ts`).
 */
export async function gradeBaseline(params: GradeBaselineParams): Promise<GradeBaselineResult> {
  const course = await getCourseById(params.courseId, params.userId);
  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `gradeBaseline: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.baseline === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `gradeBaseline: course ${course.id} has no baseline`,
    });
  }

  const stored = course.baseline as BaselineJsonb;
  // Idempotency — if gradings already exist, just return them.
  if (stored.gradings.length > 0) {
    return { gradings: stored.gradings, usage: ZERO_USAGE };
  }

  // Build byId, validate answers (every id known, no duplicates).
  const byId = Object.fromEntries(stored.questions.map((q) => [q.id, q] as const));
  const unknown = params.answers.find((a) => !(a.id in byId));
  if (unknown) throw new Error(`answer for unknown question id: ${unknown.id}`);
  const dupId = params.answers.map((a) => a.id).find((id, i, all) => all.indexOf(id) !== i);
  if (dupId !== undefined) throw new Error(`duplicate answer for question id: ${dupId}`);

  const answerById = Object.fromEntries(params.answers.map((a) => [a.id, a] as const));

  const splits = stored.questions.map((q) => {
    const a = answerById[q.id];
    if (!a) throw new Error(`no answer provided for question ${q.id}`);
    return splitOne(q, a);
  });

  const llmItems = splits.flatMap((s) => (s.kind === "llm" ? [s.item] : []));

  // All-MC shortcut.
  if (llmItems.length === 0) {
    const gradings = splits.map((s) => {
      if (s.kind !== "mechanical") throw new Error(`no mechanical grading for ${s.qid}`);
      return s.grading;
    });
    await updateCourseScopingState(course.id, {
      baseline: { ...stored, gradings },
    });
    return { gradings, usage: ZERO_USAGE };
  }

  // LLM grading via executeTurn.
  const pass = await ensureOpenScopingPass(course.id);
  const learnerInput = JSON.stringify({ items: llmItems });
  const { parsed, usage } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderStageEnvelope({ stage: "grade baseline", learnerInput }),
    responseSchema: gradeBaselineSchema,
    responseSchemaName: "grade_baseline",
    label: "grade-baseline",
    successSummary: (p) => `gradings=${p.gradings.length}`,
  });

  // Fail loud on drift between submitted and returned ids.
  const submitted = new Set(llmItems.map((i) => i.questionId));
  const returned = new Set(parsed.gradings.map((g) => g.questionId));
  const stragglers = [...returned].filter((id) => !submitted.has(id));
  if (stragglers.length > 0) {
    throw new Error(`grader returned unsubmitted ids: ${stragglers.join(", ")}`);
  }
  const omitted = [...submitted].filter((id) => !returned.has(id));
  if (omitted.length > 0) throw new Error(`grader omitted ids: ${omitted.join(", ")}`);

  const llmGradingsById = Object.fromEntries(
    parsed.gradings.map((g) => [g.questionId, g] as const),
  );

  const mergedGradings = splits.map((s) => {
    if (s.kind === "mechanical") return s.grading;
    const g = llmGradingsById[s.qid];
    if (!g) throw new Error(`no grading produced for ${s.qid}`);
    return {
      questionId: g.questionId,
      conceptName: g.conceptName,
      verdict: g.verdict,
      qualityScore: g.qualityScore,
      rationale: g.rationale,
    };
  });

  await updateCourseScopingState(course.id, {
    baseline: { ...stored, gradings: mergedGradings },
  });

  return { gradings: mergedGradings, usage };
}
