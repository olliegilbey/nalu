import { streamText, stepCountIs } from "ai";
import type { StepResult, TextStreamPart, ToolSet } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { awaitCerebrasCallSlot, recordCerebrasRateLimitHeaders } from "./cerebrasRateLimit";
import type { LlmMessage, LlmUsage } from "@/lib/types/llm";

/** Options for {@link streamToolChat}; tools are REQUIRED (that's the point). */
export interface StreamToolChatOptions {
  readonly tools: ToolSet;
  /** Loop step ceiling. Default: `LLM.maxToolSteps`. */
  readonly maxToolSteps?: number;
  readonly temperature?: number;
  readonly maxRetries?: number;
  readonly model?: LanguageModelV3;
}

/** Resolved end-of-loop result: final prose + full step trail + summed usage. */
export interface StreamToolChatFinal {
  /**
   * Closing teaching prose = the FINAL step's text. Empty when the loop ended
   * on a tool-call step (step budget exhausted before closing prose) — the
   * caller's validation gate decides whether that is acceptable.
   */
  readonly text: string;
  /** Every loop step (tool calls, tool results, per-step text) for persistence. */
  readonly steps: readonly StepResult<ToolSet>[];
  /** Token usage summed across ALL steps (each step is one provider call). */
  readonly usage: LlmUsage;
}

/** Live handle on one tool-loop call. Drain `fullStream`, then await `final()`. */
export interface StreamToolChatHandle {
  /** Raw SDK stream: text deltas, tool-input streaming, tool results, step markers. */
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  /** Resolve the end-of-loop result once the stream is fully consumed. */
  readonly final: () => Promise<StreamToolChatFinal>;
}

/**
 * Tool-loop sibling of `streamChat`: `streamText` + `tools` +
 * `stopWhen: stepCountIs(...)` instead of `output`. Same pacing contract —
 * and stricter: `prepareStep` gates EVERY loop step through
 * `awaitCerebrasCallSlot` (steps 2..N are additional provider calls that
 * `streamChat`'s single pre-call gate would miss).
 *
 * `prepareStep` also strips `reasoning` parts from assistant messages before
 * each step's request: gpt-oss-120b emits reasoning, the openai-compatible
 * adapter round-trips it as `reasoning_content`, and Cerebras rejects that
 * as an input property (400 wrong_api_format). Verified live — see
 * docs/status/2026-07-06-tool-call-probe-verdict.md finding 1.
 *
 * Docs: node_modules/ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx
 *       node_modules/ai/docs/03-agents/04-loop-control.mdx
 */
export async function streamToolChat(
  messages: readonly LlmMessage[],
  opts: StreamToolChatOptions,
): Promise<StreamToolChatHandle> {
  const result = streamText({
    model: opts.model ?? getLlmModel(),
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
    tools: opts.tools,
    stopWhen: stepCountIs(opts.maxToolSteps ?? LLM.maxToolSteps),
    prepareStep: async ({ messages: stepMessages }) => {
      // Rate-limit gate for every step, including the first (prepareStep
      // runs before each provider call — verified in installed ai@6.0.158).
      await awaitCerebrasCallSlot();
      return {
        // Strip reasoning parts (see TSDoc). Plain-string assistant messages
        // pass through untouched.
        messages: stepMessages.map((m) =>
          m.role === "assistant" && Array.isArray(m.content)
            ? { ...m, content: m.content.filter((p) => p.type !== "reasoning") }
            : m,
        ),
      };
    },
  });

  // Record rate-limit headers as soon as response metadata resolves; the
  // pre-registered no-op rejection handler prevents an unhandled rejection
  // if the stream errors before metadata arrives.
  void result.response.then(
    (r) => recordCerebrasRateLimitHeaders(r.headers),
    () => undefined,
  );

  return {
    fullStream: result.fullStream,
    final: async () => {
      const [steps, totalUsage] = await Promise.all([result.steps, result.totalUsage]);
      const lastStep = steps[steps.length - 1];
      return {
        // Final step's text = closing prose ("" if the loop ended on tools).
        text: lastStep?.text ?? "",
        steps,
        usage: totalUsage,
      };
    },
  };
}
