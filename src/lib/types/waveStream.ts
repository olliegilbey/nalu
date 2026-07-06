import type { UIMessage } from "ai";
import type { SubmitWaveTurnResult } from "@/lib/course/submitWaveTurn";

/**
 * Client-safe projection of a finished turn, delivered as a transient
 * `data-turn-result` part at the end of the stream. Shape matches what the
 * tRPC mutation returned pre-streaming, so the client's XP/close handling
 * ports across mechanically.
 */
export type WaveTurnResultData = SubmitWaveTurnResult;

/** Emitted (transient) before re-streaming after a validation retry. */
export interface WaveTurnResetData {
  readonly attempt: number;
}

/**
 * The wave-turn UI message type: no metadata; two custom data parts.
 * Server writes parts via `createUIMessageStream<WaveTurnUIMessage>`;
 * client consumes via `useChat<WaveTurnUIMessage>` `onData`.
 * Docs: node_modules/ai/docs/04-ai-sdk-ui/20-streaming-data.mdx
 *       (https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)
 */
export type WaveTurnUIMessage = UIMessage<
  never,
  {
    "turn-result": WaveTurnResultData;
    "turn-reset": WaveTurnResetData;
  }
>;
