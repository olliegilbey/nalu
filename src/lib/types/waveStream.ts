import type { InferUITools, UIMessage } from "ai";
import type { SubmitWaveTurnResult } from "@/lib/course/submitWaveTurn";
import type { WaveMidTurnAgentTools } from "@/lib/agents/waveMidTurnAgent";

/**
 * Client-safe projection of a finished turn, delivered as a transient
 * `data-turn-result` part at the end of the stream. Shape matches what the
 * tRPC mutation returned pre-streaming, so the client's XP/close handling
 * ports across mechanically.
 */
export type WaveTurnResultData = SubmitWaveTurnResult;

/**
 * Non-transient marker part written before a validation retry re-streams.
 * It lands INSIDE the assistant message's parts array; the client renders
 * only parts after the last one (failed-attempt output must not show).
 */
export interface WaveTurnResetData {
  readonly attempt: number;
}

/**
 * Mid-turn tool set as UI tool types — gives the client typed
 * `tool-recordComprehensionSignals` / `tool-presentQuestionnaire` /
 * `tool-getDueConcepts` / `tool-getConceptHistory` message parts
 * (`part.input` is the tool's validated input shape). Derived from the
 * agent's full tool map (agent-loop plan Task 4) so client and loop can
 * never drift — lookup parts stream to the client too (harmless read-only
 * projections; the UI currently ignores them).
 * Docs: node_modules/ai/docs/04-ai-sdk-ui/03-chatbot-tool-usage.mdx
 */
export type WaveTurnUITools = InferUITools<WaveMidTurnAgentTools>;

/**
 * The wave-turn UI message type: no metadata; two custom data parts; typed
 * mid-turn tool parts (generative UI — the questionnaire card renders from
 * `tool-presentQuestionnaire` input).
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
  },
  WaveTurnUITools
>;
