import { generateText, Output, NoObjectGeneratedError } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel, llmProviderOptions } from "./provider";
import { toOutputSchema } from "./toCerebrasJsonSchema";
import { llmTelemetry } from "./telemetry";
import { awaitCerebrasCallSlot } from "./cerebrasRateLimit";
import { recordStepFinished } from "./recordStepFinished";
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
 * strict `json_schema` response_format (constrained decoding on Cerebras) AND
 * the SDK validates the response against the Zod schema before returning.
 * `responseSchemaName` is the JSON Schema `name` field on the wire
 * (defaults to "response").
 */
export interface ChatOptions<T = unknown> extends GenerateOptions {
  readonly responseSchema?: z.ZodType<T>;
  readonly responseSchemaName?: string;
  /** OTel span label (pipeline stage, e.g. "wave-close"); default "generateChat". */
  readonly telemetryFunctionId?: string;
  /** The Context's id, sent as `prompt_cache_key` (see `llmProviderOptions`). */
  readonly promptCacheKey: string;
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
 * Since ai 6.0.267 that includes a truncated response: the SDK parses any
 * non-empty text whose finish reason is not `stop` or `tool-calls`, such
 * as `length`, so a cut-off reply spends a retry. Before, it threw
 * `NoOutputGeneratedError` and the Turn failed with no rows.
 *
 * Docs: node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx
 *       (https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
 *
 * Rate limiting: `awaitCerebrasCallSlot()` paces every call to stay under
 * the Cerebras PER-MINUTE limits via request spacing plus header-driven
 * token-budget backoff (see `cerebrasRateLimit.ts`). It runs in production
 * AND live smoke, including across `executeTurn`'s validation retries.
 * After the call returns — including the NoObjectGeneratedError path,
 * where the HTTP call itself succeeded — `recordStepFinished` records the
 * `x-ratelimit-*` response headers for the next call to consult, and the
 * Step's usage for the cost tally. Pacing and the tally's stderr line are
 * a complete no-op in mocked unit/integration suites.
 */
export async function generateChat<T>(
  messages: readonly LlmMessage[],
  opts: ChatOptions<T> & { responseSchema: z.ZodType<T> },
): Promise<ChatResult<T> & { parsed: T }>;
export async function generateChat(
  messages: readonly LlmMessage[],
  opts: ChatOptions,
): Promise<ChatResult>;
export async function generateChat<T>(
  messages: readonly LlmMessage[],
  opts: ChatOptions<T>,
): Promise<ChatResult<T>> {
  // Cerebras rate-limit gate. Blocks until this call is cleared under the
  // per-minute limits. No-op in mocked test suites.
  await awaitCerebrasCallSlot();

  const model = opts.model ?? getLlmModel();
  const common = {
    model,
    messages: [...messages],
    // The Harness renders the leading system message from seed columns;
    // learner text never takes the system role. Since ai 6.0.170 the SDK
    // warns on every call that carries a system message in `messages`.
    allowSystemInMessages: true,
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
    // reasoning_effort and the Context's prompt_cache_key on the wire.
    providerOptions: llmProviderOptions(opts.promptCacheKey),
    // Env-gated OTel span, stage-labelled, learner content redacted.
    experimental_telemetry: llmTelemetry(opts.telemetryFunctionId ?? "generateChat"),
  };

  // Plain-text path: no schema, no output wrapper.
  if (opts.responseSchema === undefined) {
    const result = await generateText(common);
    recordStepFinished(result.response.headers, result.usage);
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
    recordStepFinished(result.response.headers, result.usage);
    return { text: result.text, parsed: result.output, usage: result.usage };
  } catch (err) {
    // Validation failure still means the HTTP call succeeded — record the
    // rate-limit headers the error carries so the next call backs off
    // correctly, and tally the billed tokens. Then let executeTurn
    // translate the error.
    if (NoObjectGeneratedError.isInstance(err)) {
      recordStepFinished(err.response?.headers, err.usage);
    }
    throw err;
  }
}
