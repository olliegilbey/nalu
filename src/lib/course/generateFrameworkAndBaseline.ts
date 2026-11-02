import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById } from "@/db/queries/courses";
import { updateCourseScopingState } from "@/db/queries/courses.scoping";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { SCOPING } from "@/lib/config/tuning";
import { frameworkAndBaselineSchema } from "@/lib/prompts/frameworkAndBaseline";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { BaselineJsonb, ClarificationJsonb, FrameworkJsonb } from "@/lib/types/jsonb";
import { redactQuestionnaireTurn, type QuestionnaireTurnForClient } from "./redactQuestionnaire";

/** Parameters for {@link generateFrameworkAndBaseline}; responses are the learner's clarify answers. */
export interface GenerateFrameworkAndBaselineParams {
  readonly courseId: string;
  readonly userId: string;
  /** Learner responses, one per clarify question. Same order as the stored questions. */
  readonly responses: readonly { readonly questionId: string; readonly freetext: string }[];
}

/** Result of {@link generateFrameworkAndBaseline}; the framework, the baseline Turn, next stage. */
export interface GenerateFrameworkAndBaselineResult {
  readonly framework: FrameworkJsonb;
  /** The baseline Turn, projected: rubrics stay server-side; MC keys ship as `correctEnc`. */
  readonly baseline: QuestionnaireTurnForClient;
  readonly nextStage: "answering";
}

/**
 * Merged scoping Turn (issue #15): validates the clarify answers, then one LLM
 * call emits the tier ladder and the baseline written against its scope.
 * Persists both JSONB columns in one write.
 */
export async function generateFrameworkAndBaseline(
  params: GenerateFrameworkAndBaselineParams,
): Promise<GenerateFrameworkAndBaselineResult> {
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
      message: `generateFrameworkAndBaseline: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.clarification === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateFrameworkAndBaseline: course ${course.id} has no clarification`,
    });
  }
  const clarification = course.clarification as ClarificationJsonb;
  if (params.responses.length !== clarification.questions.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `responses length (${params.responses.length}) must match questions length (${clarification.questions.length})`,
    });
  }
  // Fail loud if any response references an unknown questionId, or if duplicate
  // ids slip through. The old code silently emitted `Q: (unknown <id>) ...` lines
  // to the LLM, which obscured a client-side bug as a model-quality issue.
  const knownIds = new Set(clarification.questions.map((q) => q.id));
  const unknownIds = params.responses.map((r) => r.questionId).filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `unknown questionId(s): ${[...new Set(unknownIds)].join(", ")}`,
    });
  }
  const ids = params.responses.map((r) => r.questionId);
  const dupIds = ids.filter((id, idx) => ids.indexOf(id) !== idx);
  if (dupIds.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `duplicate questionId(s): ${[...new Set(dupIds)].join(", ")}`,
    });
  }
  // Idempotency. This Turn writes both columns at once, so a course holding
  // both has run it. A framework with no baseline is a course framed before
  // the merge (issue #15), whose separate baseline Turn never landed. It falls
  // through: the Turn reruns and rewrites the framework with its baseline, so
  // the baseline's tiers always match the stored `baselineScopeTiers`.
  if (course.framework !== null && course.baseline !== null) {
    return {
      framework: course.framework as FrameworkJsonb,
      baseline: redactStoredBaseline(course.baseline as BaselineJsonb),
      nextStage: "answering",
    };
  }

  // Persist the learner's responses on the clarification row before calling the LLM,
  // so a retry of this Turn does not lose them. Idempotent: overwrites the
  // empty `responses: []` initialised by clarify.
  // Preserve the existing userMessage so the parse-before-persist guard passes.
  await updateCourseScopingState(course.id, {
    clarification: {
      userMessage: clarification.userMessage,
      questions: clarification.questions,
      responses: params.responses.map((r) => ({ questionId: r.questionId, freetext: r.freetext })),
    },
  });

  // Render responses as Q/A pairs for the envelope. Question text comes from the
  // stored questions (trusted — we generated them). Response freetext is sanitised
  // by `renderStageEnvelope` (XML escape).
  // questionIds validated above — every response now maps to a known question.
  const questionById = new Map(clarification.questions.map((q) => [q.id, q]));
  const qaPairs = params.responses
    .map((r) => {
      const q = questionById.get(r.questionId);
      if (!q) {
        throw new Error(
          `generateFrameworkAndBaseline: invariant — unknown questionId ${r.questionId}`,
        );
      }
      return `Q: ${q.prompt}\nA: ${r.freetext}`;
    })
    .join("\n\n");

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderStageEnvelope({
      stage: "generate framework and baseline",
      learnerInput: qaPairs,
    }),
    responseSchema: frameworkAndBaselineSchema,
    responseSchemaName: "framework_and_baseline",
    label: "framework-and-baseline",
    successSummary: (p) =>
      `tiers=${p.framework.tiers.length} startTier=${p.framework.estimatedStartingTier} ` +
      `scope=[${p.framework.baselineScopeTiers.join(",")}] questions=${p.baseline.questions.length}`,
  });

  // Wire shape IS storage shape: write the structured fields directly (no
  // translator). Both userMessages persist, so the chat renders the framework
  // bubble and the baseline bubble it rendered before the merge.
  const framework: FrameworkJsonb = {
    userMessage: parsed.framework.userMessage,
    tiers: parsed.framework.tiers,
    estimatedStartingTier: parsed.framework.estimatedStartingTier,
    baselineScopeTiers: parsed.framework.baselineScopeTiers,
  };
  const baseline: BaselineJsonb = {
    userMessage: parsed.baseline.userMessage,
    questions: parsed.baseline.questions,
    responses: [],
    gradings: [],
  };
  // One write, so no reader ever sees this Turn's framework without its baseline.
  await updateCourseScopingState(course.id, { framework, baseline });

  return { framework, baseline: redactStoredBaseline(baseline), nextStage: "answering" };
}

/**
 * Project a stored baseline for the client. The column keeps its questions
 * flat; the client's questionnaire Turn nests them, as clarify's does.
 */
function redactStoredBaseline(baseline: BaselineJsonb): QuestionnaireTurnForClient {
  return redactQuestionnaireTurn({
    userMessage: baseline.userMessage,
    questions: { questions: baseline.questions },
  });
}
