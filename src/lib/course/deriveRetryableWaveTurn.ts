import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";

/**
 * The failed Wave Turn a Retry may re-send, or null. Pure (issue #231).
 *
 * `prepareWaveTurn` saves the learner entry before the LLM call. When the call
 * fails, that entry trails the chat log with no reply, and it counts as a spent
 * Turn. Re-sending the identical payload takes the server's resume path
 * (`learnerEntryAlreadyAppended`), which reuses the entry. Any other text would
 * append a new one.
 *
 * So the Retry is offered only after this tab saw the Turn fail, and only while
 * the log still ends with a learner entry. A Turn in flight looks the same in
 * the log, which is why the tab's own failure gates it. A log ending in an
 * assistant entry means the entry was never saved, or the reply landed despite
 * the client error: nothing is spent, and a re-send would spend a Turn.
 *
 * The trailing entry is taken to be this payload's: one tab sends one Turn at
 * a time.
 */
export function deriveRetryableWaveTurn(
  failedPayload: SubmitTurnPayload | null,
  chatLog: readonly WaveChatLogEntryForClient[],
): SubmitTurnPayload | null {
  if (failedPayload === null) return null;
  return chatLog.at(-1)?.role === "user" ? failedPayload : null;
}
