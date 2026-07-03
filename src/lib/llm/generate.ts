import { generateText, Output, NoObjectGeneratedError } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { toOutputSchema } from "./toCerebrasJsonSchema";
import { awaitCerebrasCallSlot, recordCerebrasRateLimitHeaders } from "./cerebrasRateLimit";
import type { LlmMessage, LlmUsage } from "@/lib/types/llm";

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
  readonly model?: LanguageModelV3;
}

/**
 * Chat-call extension: when `responseSchema` is provided, the call sends a
 * strict `json_schema` response_format (soft guidance on Cerebras) AND the
 * SDK validates the response against the Zod schema before returning.
 * `responseSchemaName` is the JSON Schema `name` field on the wire
 * (defaults to "response").
 */
export interface ChatOptions<T = unknown> extends GenerateOptions {
  readonly responseSchema?: z.ZodType<T>;
  readonly responseSchemaName?: string;
}

/**
 * Successful chat result. When `responseSchema` was supplied, `parsed` is
 * the schema-validated object and `text` is the raw JSON string it was
 * parsed from (persisted verbatim by executeTurn); otherwise `parsed` is
 * absent and `text` is raw model prose.
 */
export interface ChatResult<T = unknown> {
  /** Raw model output (JSON string or prose). */
  readonly text: string;
  /** Schema-validated object; present iff `responseSchema` was supplied. */
  readonly parsed?: T;
  /** Provider-reported token usage for this call. */
  readonly usage: LlmUsage;
}

/**
 * Chat call. When `responseSchema` is supplied, the AI SDK's
 * `Output.object` mechanism is used: `toOutputSchema` preserves the
 * Cerebras-cleaned wire bytes, and the SDK runs Zod validation (refines
 * included) on the response. Validation or JSON-parse failure throws the
 * SDK's `NoObjectGeneratedError` (carrying `text` + `usage`); transport
 * errors propagate as before. `executeTurn` converts
 * `NoObjectGeneratedError` into its `ValidationGateFailure` retry flow.
 *
 * Docs: node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx
 *       (https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
 *
 * Rate limiting: `awaitCerebrasCallSlot()` paces every call to stay under
 * the Cerebras PER-MINUTE limits via request spacing plus header-driven
 * token-budget backoff (see `cerebrasRateLimit.ts`). It runs in production
 * AND live smoke, including across `executeTurn`'s validation retries.
 * After the call returns — including the NoObjectGeneratedError path,
 * where the HTTP call itself succeeded — the `x-ratelimit-*` response
 * headers are recorded for the next call to consult. Both are a complete
 * no-op in mocked unit/integration suites.
 */
export async function generateChat<T>(
  messages: readonly LlmMessage[],
  opts: ChatOptions<T> & { responseSchema: z.ZodType<T> },
): Promise<ChatResult<T> & { parsed: T }>;
export async function generateChat(
  messages: readonly LlmMessage[],
  opts?: ChatOptions,
): Promise<ChatResult>;
export async function generateChat<T>(
  messages: readonly LlmMessage[],
  opts: ChatOptions<T> = {},
): Promise<ChatResult<T>> {
  // Cerebras rate-limit gate. Blocks until this call is cleared under the
  // per-minute limits. No-op in mocked test suites.
  await awaitCerebrasCallSlot();

  const model = opts.model ?? getLlmModel();
  const common = {
    model,
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
  };

  // Plain-text path: no schema, no output wrapper.
  if (opts.responseSchema === undefined) {
    const result = await generateText(common);
    recordCerebrasRateLimitHeaders(result.response.headers);
    return { text: result.text, usage: result.usage };
  }

  // Structured path: Output.object sets callOptions.responseFormat from
  // toOutputSchema (Cerebras-cleaned wire bytes) and validates the response
  // with the Zod schema before returning.
  const name = opts.responseSchemaName ?? "response";
  try {
    const result = await generateText({
      ...common,
      output: Output.object({
        schema: toOutputSchema(opts.responseSchema, { name }),
        name,
      }),
    });
    recordCerebrasRateLimitHeaders(result.response.headers);
    return { text: result.text, parsed: result.output, usage: result.usage };
  } catch (err) {
    // Validation failure still means the HTTP call succeeded — record the
    // rate-limit headers the error carries so the next call backs off
    // correctly, then let executeTurn translate the error.
    if (NoObjectGeneratedError.isInstance(err)) {
      recordCerebrasRateLimitHeaders(err.response?.headers);
    }
    throw err;
  }
}
