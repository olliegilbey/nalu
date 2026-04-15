import { generateStructured } from "@/lib/llm/generate";
import {
  buildFrameworkPrompt,
  frameworkSchema,
  type ClarificationExchange,
  type Framework,
} from "@/lib/prompts";
import type { LlmUsage } from "@/lib/types/llm";

/** Params for {@link generateFramework}. Object shape keeps callers future-proof. */
export interface GenerateFrameworkParams {
  /** Raw, untrusted topic string from the learner. Sanitised downstream. */
  readonly topic: string;
  /** Q&A pairs from the prior clarification turn. Answers are sanitised downstream. */
  readonly clarifications: readonly ClarificationExchange[];
}

/**
 * Result of a framework-generation turn: the validated proficiency
 * framework plus token usage for telemetry.
 */
export interface GenerateFrameworkResult {
  readonly framework: Framework;
  readonly usage: LlmUsage;
}

/**
 * Drive the framework-generation turn (PRD §4.1 step 2) of new-course
 * onboarding.
 *
 * Thin orchestrator: builds the scoping prompt (which internally sanitises
 * the topic and each answer), hands it to `generateStructured` with the
 * framework schema, and returns the validated payload. All prompt text
 * and the schema are owned by `src/lib/prompts/framework.ts`; this module
 * only wires them to the LLM.
 *
 * Usage is propagated so the router can record telemetry per PRD §9.
 */
export async function generateFramework(
  params: GenerateFrameworkParams,
): Promise<GenerateFrameworkResult> {
  const messages = buildFrameworkPrompt({
    topic: params.topic,
    clarifications: params.clarifications,
  });
  const { object, usage } = await generateStructured(frameworkSchema, messages);
  return { framework: object, usage };
}
