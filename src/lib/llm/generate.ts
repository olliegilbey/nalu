import { generateText } from "ai";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { toCerebrasJsonSchema } from "./toCerebrasJsonSchema";
import type { LlmMessage, LlmModel, LlmUsage } from "@/lib/types/llm";

/**
 * Options common to the chat wrapper. All optional — `tuning.LLM`
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
 * Successful chat result. When `responseSchema` is supplied the `text`
 * field is a JSON string guaranteed to match the schema; otherwise it is
 * raw model output.
 */
export interface ChatResult {
  /** Raw model output (JSON string or prose). */
  readonly text: string;
  /** Provider-reported token usage for this call. */
  readonly usage: LlmUsage;
}

/**
 * Chat call. When `responseSchema` is supplied, Cerebras constrained decoding
 * guarantees the output parses as JSON matching the schema (modulo business
 * invariants — those still run Zod-side in the caller).
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
