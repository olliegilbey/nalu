import { generateStructured } from "@/lib/llm/generate";
import { buildClarificationPrompt, clarifyingQuestionsSchema } from "@/lib/prompts";
import type { LlmUsage } from "@/lib/types/llm";

/** Params for {@link clarifyTopic}. Object shape keeps the call site future-proof. */
export interface ClarifyTopicParams {
  /** Raw, untrusted topic string from the learner. Sanitised downstream. */
  readonly topic: string;
}

/** Result of a clarification turn: 2–4 questions plus token usage for telemetry. */
export interface ClarifyTopicResult {
  readonly questions: readonly string[];
  readonly usage: LlmUsage;
}

/**
 * Drive the topic-clarification turn of new-course onboarding.
 *
 * Thin orchestrator: builds the scoping prompt (which internally sanitises
 * the topic), hands it to `generateStructured` with the clarifying-questions
 * schema, and returns the validated payload. All prompt text and the schema
 * are owned by `src/lib/prompts/clarification.ts`; this module only wires
 * them to the LLM.
 *
 * Usage is propagated so the caller (router) can record telemetry.
 */
export async function clarifyTopic(params: ClarifyTopicParams): Promise<ClarifyTopicResult> {
  const messages = buildClarificationPrompt({ topic: params.topic });
  const { object, usage } = await generateStructured(clarifyingQuestionsSchema, messages);
  return { questions: object.questions, usage };
}
