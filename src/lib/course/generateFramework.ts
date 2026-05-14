import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { SCOPING } from "@/lib/config/tuning";
import { frameworkSchema, type Framework } from "@/lib/prompts/framework";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
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
  // Idempotency.
  if (course.framework !== null) {
    return { framework: course.framework as FrameworkJsonb, nextStage: "baseline" };
  }

  // Persist the learner's responses on the clarification row before calling the LLM,
  // so a retry of generateFramework does not lose them. Idempotent: overwrites the
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
      if (!q) throw new Error(`generateFramework: invariant — unknown questionId ${r.questionId}`);
      return `Q: ${q.prompt}\nA: ${r.freetext}`;
    })
    .join("\n\n");

  const pass = await ensureOpenScopingPass(course.id);
  // Build schema string regardless — retry directive always needs it.
  // Gate the inline on model capability: weak models (honorsStrictMode=false)
  // get the schema inlined in the envelope; strong models read it from the
  // wire response_format and don't need the extra tokens.
  const modelName = process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);
  const schemaJson = toSchemaJsonString(frameworkSchema, { name: "framework" });
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderStageEnvelope({
      stage: "generate framework",
      learnerInput: qaPairs,
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
    }),
    responseSchema: frameworkSchema,
    responseSchemaName: "framework",
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "framework",
    successSummary: (p) => `tiers=${p.tiers.length} startTier=${p.estimatedStartingTier}`,
  });

  // Wire shape IS storage shape — write the structured fields directly (no translator).
  // userMessage persisted so cached-replay returns the model's framing, not "" —
  // symmetric with clarify/baseline.
  const jsonb: FrameworkJsonb = {
    userMessage: parsed.userMessage,
    tiers: parsed.tiers,
    estimatedStartingTier: parsed.estimatedStartingTier,
    baselineScopeTiers: parsed.baselineScopeTiers,
  };
  await updateCourseScopingState(course.id, { framework: jsonb });

  return { framework: jsonb, nextStage: "baseline" };
}

/** Re-exported for routers + tests. */
export type { Framework };
