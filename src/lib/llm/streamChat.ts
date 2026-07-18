import { streamText, Output } from "ai";
import type { DeepPartial } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { toOutputSchema } from "./toCerebrasJsonSchema";
import { awaitCerebrasCallSlot, recordCerebrasRateLimitHeaders } from "./cerebrasRateLimit";
import { llmTelemetry } from "./telemetry";
import type { LlmMessage, LlmUsage } from "@/lib/types/llm";

/** Options for {@link streamChat}; schema is REQUIRED (streaming is only used for structured turns). */
export interface StreamChatOptions<T> {
  readonly responseSchema: z.ZodType<T>;
  readonly responseSchemaName?: string;
  readonly temperature?: number;
  readonly maxRetries?: number;
  readonly model?: LanguageModelV3;
  /** OTel span label (pipeline stage, e.g. "wave-mid"); default "streamChat". */
  readonly telemetryFunctionId?: string;
}

/** Resolved end-of-stream result: validated object + raw text + usage. */
export interface StreamChatFinal<T> {
  readonly parsed: T;
  readonly text: string;
  readonly usage: LlmUsage;
}

/** Live handle on one streaming LLM call. Iterate partials, then await final(). */
export interface StreamChatHandle<T> {
  /** Repaired-JSON partials of the response object. NOT validated — display only. */
  readonly partialOutputStream: AsyncIterable<DeepPartial<T>>;
  /** Resolve the validated final result; rejects with NoObjectGeneratedError on parse/validation failure. */
  readonly final: () => Promise<StreamChatFinal<T>>;
}

/**
 * Streaming sibling of `generateChat`, for structured turns whose prose the
 * UI wants progressively. Same rate-limit gate, same Cerebras wire bytes
 * (via `toOutputSchema`), same error contract (`NoObjectGeneratedError` on
 * invalid output — `executeTurnStream` converts it to the retry flow).
 *
 * Docs: node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx
 *       (https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
 *       https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
 */
export async function streamChat<T>(
  messages: readonly LlmMessage[],
  opts: StreamChatOptions<T>,
): Promise<StreamChatHandle<T>> {
  // Same pacing gate as generateChat — every Cerebras call goes through it.
  await awaitCerebrasCallSlot();

  const name = opts.responseSchemaName ?? "response";
  const result = streamText({
    model: opts.model ?? getLlmModel(),
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
    output: Output.object({ schema: toOutputSchema(opts.responseSchema, { name }), name }),
    // Env-gated OTel span, stage-labelled, learner content redacted.
    experimental_telemetry: llmTelemetry(opts.telemetryFunctionId ?? "streamChat"),
  });

  // Pre-register rejection handling so an output validation failure can't
  // become an unhandled rejection while the caller is still draining
  // partials. (`output` is PromiseLike on the public type — no `.catch`.)
  void result.output.then(undefined, () => undefined);

  // Record rate-limit headers as soon as response metadata resolves —
  // even when validation later fails, the HTTP call itself succeeded.
  void result.response.then(
    (r) => recordCerebrasRateLimitHeaders(r.headers),
    () => undefined,
  );

  return {
    partialOutputStream: result.partialOutputStream,
    final: async () => {
      const [parsed, text, usage] = await Promise.all([result.output, result.text, result.usage]);
      return { parsed, text, usage };
    },
  };
}
