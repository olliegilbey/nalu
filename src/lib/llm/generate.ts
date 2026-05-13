import { generateObject, generateText } from "ai";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { toCerebrasJsonSchema } from "./toCerebrasJsonSchema";
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
 * Chat-call extension: when `responseSchema` is provided, the call uses
 * Cerebras strict-mode constrained decoding — the model can only emit JSON
 * matching the schema. `responseSchemaName` is the JSON Schema `name`
 * field on the wire (defaults to "response").
 */
export interface ChatOptions extends GenerateOptions {
  readonly responseSchema?: z.ZodType<unknown>;
  readonly responseSchemaName?: string;
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
 * Successful chat result. When `responseSchema` is supplied the `text`
 * field is a JSON string guaranteed to match the schema; otherwise it is
 * raw model output and callers extract embedded XML via `extractTag`.
 */
export interface ChatResult {
  /** Raw model output (JSON string or prose). */
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
 *
 * @deprecated Slated for deletion in Task 14 once `gradeBaseline` migrates
 * to `executeTurn` + `responseSchema`. New code MUST NOT call this.
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
 * Chat call. When `responseSchema` is supplied, Cerebras constrained decoding
 * guarantees the output parses as JSON matching the schema (modulo business
 * invariants — those still run Zod-side in the caller). Without
 * `responseSchema`, the call is unconstrained and the output is raw prose
 * that callers extract embedded XML from via `extractTag`.
 */
export async function generateChat(
  messages: readonly LlmMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  // Build the responseFormat only when a schema is explicitly provided.
  // Spreading undefined keys into generateText args would send them as
  // `responseFormat: undefined` which some SDK versions treat as an error.
  const responseFormat =
    opts.responseSchema !== undefined
      ? toCerebrasJsonSchema(opts.responseSchema, {
          name: opts.responseSchemaName ?? "response",
        })
      : undefined;

  const result = await generateText({
    model: opts.model ?? getLlmModel(),
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
    // Conditionally spread so the key is absent (not undefined) when unused.
    ...(responseFormat !== undefined ? { responseFormat } : {}),
  });
  return { text: result.text, usage: result.usage };
}
