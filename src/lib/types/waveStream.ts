import type { InferUITools, UIMessage } from "ai";
import type { PersistWaveMidTurnResult } from "@/lib/course/persistWaveMidTurn";
import type { ExecuteWaveCloseResult } from "@/lib/course/executeWaveClose";
import type { WaveMidTurnAgentTools } from "@/lib/agents/waveMidTurnAgent";

/**
 * Client-safe projection of a finished turn, delivered as a transient
 * `data-turn-result` part at the end of the stream. `kind` tells a mid-turn
 * result from a close-turn result.
 */
export type WaveTurnResultData = PersistWaveMidTurnResult | ExecuteWaveCloseResult;

/**
 * Non-transient marker part written before a validation retry re-streams.
 * It lands INSIDE the assistant message's parts array; the client renders
 * only parts after the last one (failed-attempt output must not show).
 */
export interface WaveTurnResetData {
  readonly attempt: number;
}

/**
 * Mid-turn tools whose chunks reach the client (issue #59). Only the quiz
 * card has a consumer; lookup and grading-signal chunks stay server-side.
 * `streamWaveTurn`'s forwarding allowlist is typed by this.
 */
export type ClientForwardedToolName = keyof Pick<WaveMidTurnAgentTools, "presentQuestionnaire">;

/**
 * Forwarded mid-turn tools as UI tool types — gives the client a typed
 * `tool-presentQuestionnaire` message part (`part.input` is the tool's
 * validated input shape). Picked from the agent's full tool map (agent-loop
 * plan Task 4) so client and loop can never drift.
 * Docs: node_modules/ai/docs/04-ai-sdk-ui/03-chatbot-tool-usage.mdx
 */
export type WaveTurnUITools = InferUITools<Pick<WaveMidTurnAgentTools, ClientForwardedToolName>>;

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
