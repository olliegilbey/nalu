import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { SCOPING } from "@/lib/config/tuning";
import { frameworkSchema, type Framework } from "@/lib/prompts/framework";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { ClarificationJsonb, FrameworkJsonb } from "@/lib/types/jsonb";

export interface GenerateFrameworkParams {
  readonly courseId: string;
  readonly userId: string;
  /** Learner responses, one per clarify question. Same order as the stored questions. */
  readonly responses: readonly { readonly questionId: string; readonly freetext: string }[];
}

export interface GenerateFrameworkResult {
  readonly framework: FrameworkJsonb;
  readonly nextStage: "baseline";
}

export async function generateFramework(
  params: GenerateFrameworkParams,
): Promise<GenerateFrameworkResult> {
  if (params.responses.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "responses cannot be empty" });
  }
  if (params.responses.length > SCOPING.maxClarifyAnswers) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `at most ${SCOPING.maxClarifyAnswers} responses allowed`,
    });
  }

  const course = await getCourseById(params.courseId, params.userId);
  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateFramework: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.clarification === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateFramework: course ${course.id} has no clarification`,
    });
  }
  const clarification = course.clarification as ClarificationJsonb;
  if (params.responses.length !== clarification.questions.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `responses length (${params.responses.length}) must match questions length (${clarification.questions.length})`,
    });
  }
  // Idempotency.
  if (course.framework !== null) {
    return { framework: course.framework as FrameworkJsonb, nextStage: "baseline" };
  }

  // Persist the learner's responses on the clarification row before calling the LLM,
  // so a retry of generateFramework does not lose them. Idempotent: overwrites the
  // empty `responses: []` initialised by clarify.
  await updateCourseScopingState(course.id, {
    clarification: {
      questions: clarification.questions,
      responses: params.responses.map((r) => ({ questionId: r.questionId, freetext: r.freetext })),
    },
  });

  // Render responses as Q/A pairs for the envelope. Question text comes from the
  // stored questions (trusted — we generated them). Response freetext is sanitised
  // by `renderStageEnvelope` (XML escape).
  const qaPairs = params.responses
    .map((r) => {
      const q = clarification.questions.find((q) => q.id === r.questionId);
      return q
        ? `Q: ${q.prompt}\nA: ${r.freetext}`
        : `Q: (unknown ${r.questionId})\nA: ${r.freetext}`;
    })
    .join("\n\n");

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderStageEnvelope({
      stage: "generate framework",
      learnerInput: qaPairs,
    }),
    responseSchema: frameworkSchema,
    responseSchemaName: "framework",
    label: "framework",
    successSummary: (p) => `tiers=${p.tiers.length} startTier=${p.estimatedStartingTier}`,
  });

  // Wire shape IS storage shape — write the structured fields directly (no translator).
  // `userMessage` is the chat bubble; we drop it from JSONB persistence because it's
  // not re-read after the turn (UI re-uses the assistant_response row for replay).
  const jsonb: FrameworkJsonb = {
    tiers: parsed.tiers,
    estimatedStartingTier: parsed.estimatedStartingTier,
    baselineScopeTiers: parsed.baselineScopeTiers,
  };
  await updateCourseScopingState(course.id, { framework: jsonb });

  return { framework: jsonb, nextStage: "baseline" };
}

/** Re-exported for routers + tests. */
export type { Framework };
