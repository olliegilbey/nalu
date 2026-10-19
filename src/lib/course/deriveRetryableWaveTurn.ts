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
 * So this offers a Retry only after this tab saw the Turn fail, and only while
 * the log still ends with this payload's entry. A Turn in flight looks the same
 * in the log, so the tab's own failure gates it. A log ending in an assistant
 * entry means the server never saved the entry, or the reply landed despite
 * the client error: nothing is spent, and a re-send would spend a Turn.
 *
 * A dropped connection fails the client while the server may still run the
 * Turn. A Retry then starts a second run on the same entry (issue #245).
 */
export function deriveRetryableWaveTurn(
  failedPayload: SubmitTurnPayload | null,
  chatLog: readonly WaveChatLogEntryForClient[],
): SubmitTurnPayload | null {
  if (failedPayload === null) return null;
  const trailing = chatLog.at(-1);
  return trailing !== undefined && isSavedEntryOf(trailing, failedPayload) ? failedPayload : null;
}

/**
 * True when `entry` is the learner entry `prepareWaveTurn` saved for `payload`.
 * An answers entry matches on its questionnaire id: each questionnaire takes
 * one answers entry, and this tab sent only one.
 */
function isSavedEntryOf(entry: WaveChatLogEntryForClient, payload: SubmitTurnPayload): boolean {
  if (entry.role !== "user") return false;
  if (payload.kind === "chat-text") {
    return entry.kind === "text" && entry.content === payload.text;
  }
  return entry.kind === "answers" && entry.questionnaireId === payload.questionnaireId;
}
