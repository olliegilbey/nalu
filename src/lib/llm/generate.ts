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

/**
 * Successful structured-output result.
 *
 * @typeParam T - The Zod-inferred shape returned by the caller's schema.
 *                The SDK guarantees `object` parses under that schema.
 */
export interface StructuredResult<T> {
  /** Parsed, schema-validated payload. */
  readonly object: T;
  /** Provider-reported token usage for this call. */
  readonly usage: LlmUsage;
}

/**
 * Successful free-form chat result. Text is raw model output — callers
 * extract embedded XML blocks via `extractTag` and Zod-validate the
 * payload at that boundary.
 */
export interface ChatResult {
  /** Raw model output. May be empty on abnormal completions. */
  readonly text: string;
  /** Provider-reported token usage for this call. */
  readonly usage: LlmUsage;
}

/**
 * Structured-output call. Hands a Zod schema to the AI SDK, which uses
 * provider-native JSON-schema enforcement where available (Cerebras
 * does) and falls back to prompt-coaxed JSON + validation elsewhere.
 *
 * `maxRetries` bounds transport-level retries (timeouts, 5xx). The
 * SDK's internal JSON-parse repair is a separate, automatic pass.
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
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
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
