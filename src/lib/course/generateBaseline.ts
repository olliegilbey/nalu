import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { makeBaselineSchema, type BaselineTurn } from "@/lib/prompts/baseline";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { BaselineJsonb, FrameworkJsonb } from "@/lib/types/jsonb";

export interface GenerateBaselineParams {
  readonly courseId: string;
  readonly userId: string;
}

export interface GenerateBaselineResult {
  readonly baseline: BaselineTurn;
  readonly nextStage: "answering";
}

export async function generateBaseline(
  params: GenerateBaselineParams,
): Promise<GenerateBaselineResult> {
  const course = await getCourseById(params.courseId, params.userId);

  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateBaseline: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.clarification === null || course.framework === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateBaseline: course ${course.id} requires both clarification and framework`,
    });
  }

  const framework = course.framework as FrameworkJsonb;
  const scopeTiers = framework.baselineScopeTiers;
  const schema = makeBaselineSchema({ scopeTiers });

  if (course.baseline !== null) {
    const stored = course.baseline as BaselineJsonb;
    // Re-validate the stored questions against the per-call schema so the
    // returned BaselineTurn matches the freshly-typed shape.
    const out = schema.parse({
      userMessage: "",
      questions: { questions: stored.questions },
    });
    return { baseline: out, nextStage: "answering" };
  }

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderStageEnvelope({
      stage: "generate baseline",
      // Stage envelope carries no learner input on this turn — scope is in the
      // schema description. Empty learner_input is the bare-stage signal.
      learnerInput: "",
    }),
    responseSchema: schema,
    responseSchemaName: "baseline",
    label: "baseline",
    successSummary: (p) => `questions=${p.questions.questions.length}`,
  });

  const jsonb: BaselineJsonb = {
    questions: parsed.questions.questions,
    responses: [],
    gradings: [],
  };
  await updateCourseScopingState(course.id, { baseline: jsonb });

  return { baseline: parsed, nextStage: "answering" };
}
