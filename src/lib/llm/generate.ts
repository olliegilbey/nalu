import { generateObject, generateText } from "ai";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import type { LlmMessage, LlmModel, LlmUsage } from "@/lib/types/llm";

/**
 * Options common to both generate wrappers. All optional — `tuning.LLM`
 * supplies defaults. Callers override per-flow (e.g. a creative framing
 * prompt may raise temperature).
 */
export interface GenerateOptions {
  /** 0–1. Lower → more consistent. Default: `LLM.defaultTemperature`. */
  readonly temperature?: number;
  /** Transport-level retries on transient errors. Default: `LLM.maxRetries`. */
  readonly maxRetries?: number;
  /** Override the model for a single call (testing, capability routing). */
  readonly model?: LlmModel;
}

export interface StructuredResult<T> {
  readonly object: T;
  readonly usage: LlmUsage;
}

export interface ChatResult {
  readonly text: string;
  readonly usage: LlmUsage;
}

/**
 * Structured-output call. Hands a Zod schema to the AI SDK, which uses
 * provider-native JSON-schema enforcement where available (Cerebras
 * does) and falls back to prompt-coaxed JSON + validation elsewhere.
 *
 * Retry/repair on Zod-validation failures is handled by the SDK —
 * `structuredRepairAttempts` is the budget.
 */
export async function generateStructured<T>(
  schema: z.ZodType<T>,
  messages: readonly LlmMessage[],
  opts: GenerateOptions = {},
): Promise<StructuredResult<T>> {
  const result = await generateObject({
    model: opts.model ?? getLlmModel(),
    schema,
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.structuredRepairAttempts,
  });
  return { object: result.object as T, usage: result.usage };
}

/**
 * Free-form chat call. Used for PRD §5 conversational turns that mix
 * prose with embedded structured XML blocks (`<assessment>`, etc.).
 * Callers extract blocks via `extractTag` and Zod-validate the payload.
 */
export async function generateChat(
  messages: readonly LlmMessage[],
  opts: GenerateOptions = {},
): Promise<ChatResult> {
  const result = await generateText({
    model: opts.model ?? getLlmModel(),
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
  });
  return { text: result.text, usage: result.usage };
}
