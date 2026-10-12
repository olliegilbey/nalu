import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { createCourse, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { clarifySchema, type ClarifyTurn } from "@/lib/prompts/clarify";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { notifyEvent } from "@/lib/notify/ntfy";
import type { ClarificationJsonb } from "@/lib/types/jsonb";

/** Parameters for {@link clarify}. */
export interface ClarifyParams {
  readonly userId: string;
  readonly topic: string;
}

/** Result of {@link clarify}; carries the freshly-created course id + clarify payload. */
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

  // Fire-and-forget ping: notify operator that a new course has started.
  // Sent before the LLM call so we hear about attempts even if Cerebras fails.
  // `VERCEL_ENV` is set automatically on Vercel deploys (production/preview/development);
  // locally it's undefined, so we label as "dev" — useful to distinguish real-user traffic
  // from our own testing without leaking any user identifier to the third-party service.
  const env = process.env.VERCEL_ENV ?? "dev";
  notifyEvent({
    title: "Nalu: new course",
    message: `[${env}] Topic: ${params.topic}`,
  });

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
  // Schema string retained only for the retry directive — a failed model must
  // see the contract again inline (`buildRetryDirective`). The wire-side
  // `response_format` carries the schema on every normal turn.
  // `sanitiseUserInput` is intentionally NOT applied here: the
  // `<user_message>` wrapper was a teaching-layer convention and the new
  // scoping system prompt doesn't reference it. `renderStageEnvelope`
  // already XML-escapes `learnerInput`, so passing the raw topic is safe.
  const schemaJson = toSchemaJsonString(clarifySchema, { name: "clarify" });
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: params.topic },
    userMessageContent: renderStageEnvelope({
      stage: "clarify",
      learnerInput: params.topic,
    }),
    responseSchema: clarifySchema,
    responseSchemaName: "clarify",
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
