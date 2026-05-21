import { generateText } from "ai";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { toCerebrasJsonSchema } from "./toCerebrasJsonSchema";
import { getModelCapabilities } from "./modelCapabilities";
import { awaitCerebrasCallSlot, recordCerebrasRateLimitHeaders } from "./cerebrasRateLimit";
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
  /**
   * Model name override for capability lookup. Set this alongside `model`
   * when the override is a different model than `process.env.LLM_MODEL`,
   * otherwise the capability gate could send `response_format` to a model
   * that ignores strict-mode (or strip it from one that needs it).
   */
  readonly modelName?: string;
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
 * is used — but only for models that honour strict-mode JSON schema decoding.
 *
 * WHY the model gate: weak models (e.g. llama3.1-8b on Cerebras free tier)
 * silently ignore `response_format: { type: "json_schema", strict: true }` and
 * emit free-form JSON anyway. Sending `response_format` to them wastes bytes on
 * the wire and obscures the actual contract. Those models get an inline
 * `<response_schema>` block in the user envelope instead (handled at the prompt
 * assembly layer in `src/lib/course/`). Strong models (e.g. llama-3.3-70b)
 * honour strict-mode; they get `response_format` only and no inline duplicate.
 *
 * Model name is read from `process.env.LLM_MODEL` (the same source `provider.ts`
 * uses to configure the provider). An unrecognised model defaults to
 * `honorsStrictMode: true` — see `modelCapabilities.ts`.
 *
 * Rate limiting: `awaitCerebrasCallSlot()` paces every call to stay under
 * the Cerebras free-tier limits (5 RPM + 30k tokens/min) — request spacing
 * plus header-driven token-budget backoff. It runs in production AND live
 * smoke, including across `executeTurn`'s validation retries (each a
 * separate API call). After the call returns, the `x-ratelimit-*` response
 * headers are recorded for the next call to consult. Both are a complete
 * no-op in mocked unit/integration suites — see `cerebrasRateLimit.ts`.
 */
export async function generateChat(
  messages: readonly LlmMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  // Determine whether this model honours strict-mode constrained decoding.
  // `opts.modelName` is the test/override seam — it wins over the env so
  // capability detection stays in sync with the actual provider call when a
  // test injects a different `opts.model`.
  const modelName = opts.modelName ?? process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);

  // Build the responseFormat only when a schema is provided AND the model
  // will actually honour it. Spreading undefined into generateText would
  // send `responseFormat: undefined`, which some SDK versions treat as an error.
  const responseFormat =
    opts.responseSchema !== undefined && capabilities.honorsStrictMode
      ? toCerebrasJsonSchema(opts.responseSchema, {
          name: opts.responseSchemaName ?? "response",
        })
      : undefined;

  // Cerebras rate-limit gate. Blocks until this call is cleared under the
  // free-tier limits (request spacing + token-budget backoff). No-op in
  // mocked test suites; active in production and live smoke, so even
  // executeTurn's back-to-back validation retries stay under the cap.
  await awaitCerebrasCallSlot();

  const result = await generateText({
    model: opts.model ?? getLlmModel(),
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
    // Conditionally spread so the key is absent (not undefined) when unused.
    ...(responseFormat !== undefined ? { responseFormat } : {}),
  });
  // Capture the Cerebras x-ratelimit-* headers so the next call can back
  // off when the per-minute token budget runs low. `response.headers` is
  // `Record<string,string> | undefined` (undefined for non-HTTP providers).
  recordCerebrasRateLimitHeaders(result.response.headers);
  return { text: result.text, usage: result.usage };
}
