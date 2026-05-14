import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { createCourse, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { clarifySchema, type ClarifyTurn } from "@/lib/prompts/clarify";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
import type { ClarificationJsonb } from "@/lib/types/jsonb";

/** Parameters for {@link clarify}. */
export interface ClarifyParams {
  readonly userId: string;
  readonly topic: string;
}

export interface ClarifyResult {
  readonly courseId: string;
  /** Full Questionnaire payload — the UI renders cards from this. */
  readonly clarification: ClarifyTurn;
  readonly nextStage: "framework";
}

/**
 * Drive the clarify turn.
 *
 * Flow: createCourse → ensureOpenScopingPass → executeTurn(responseSchema=clarifySchema)
 *   → persist wire shape directly (no translator) → return.
 *
 * The persisted JSONB shape is `{ questions, responses: [] }` — responses
 * are populated after the learner submits answers via the next router call.
 */
export async function clarify(params: ClarifyParams): Promise<ClarifyResult> {
  const course = await createCourse({ userId: params.userId, topic: params.topic });

  if (course.clarification !== null) {
    // Idempotency: rebuild ClarifyTurn from stored JSONB. `courseRowGuard`
    // already validated the row against `clarificationJsonbSchema`.
    const stored = course.clarification as ClarificationJsonb;
    return {
      courseId: course.id,
      clarification: {
        userMessage: stored.userMessage,
        questions: { questions: stored.questions },
      },
      nextStage: "framework",
    };
  }

  const pass = await ensureOpenScopingPass(course.id);
  // Build schema string regardless — retry directive always needs it (the
  // model failed and must see the contract again even on strong models).
  // `sanitiseUserInput` is intentionally NOT applied here: the
  // `<user_message>` wrapper was a teaching-layer convention and the new
  // scoping system prompt doesn't reference it. `renderStageEnvelope`
  // already XML-escapes `learnerInput`, so passing the raw topic is safe.
  const modelName = process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);
  const schemaJson = toSchemaJsonString(clarifySchema, { name: "clarify" });
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: params.topic },
    userMessageContent: renderStageEnvelope({
      stage: "clarify",
      learnerInput: params.topic,
      // Inline schema only for models that ignore wire response_format.
      // Strong models read the schema from the wire; sending it inline too
      // wastes ~3-5 KB per turn without adding reliability.
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
    }),
    responseSchema: clarifySchema,
    responseSchemaName: "clarify",
    // Schema always provided to retry directive — a failed model must see the
    // contract again regardless of whether it normally honours strict-mode.
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "clarify",
    successSummary: (p) => `questions=${p.questions.questions.length}`,
  });

  // Persist wire shape directly. responses start empty; populated after the learner submits.
  // userMessage persisted so cached-replay returns the model's framing, not "".
  await updateCourseScopingState(course.id, {
    clarification: {
      userMessage: parsed.userMessage,
      questions: parsed.questions.questions,
      responses: [],
    },
  });

  return { courseId: course.id, clarification: parsed, nextStage: "framework" };
}
