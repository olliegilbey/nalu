import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";
import { learnerEntryAlreadyAppended } from "./learnerEntryAlreadyAppended";
import { learnerEntryForPayload } from "./learnerEntryForPayload";
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
 * the server would reuse the trailing entry. It runs the server's own check,
 * on the entry the server builds from the payload, so the two cannot disagree.
 * A Turn in flight looks the same in the log, so the tab's own failure gates
 * it. A log ending in any other entry means the server never saved this one,
 * or the reply landed despite the client error: a re-send would spend a Turn.
 *
 * A dropped connection fails the client while the server may still run the
 * Turn. A Retry then starts a second run on the same entry (issue #245).
 */
export function deriveRetryableWaveTurn(
  failedPayload: SubmitTurnPayload | null,
  chatLog: readonly WaveChatLogEntryForClient[],
): SubmitTurnPayload | null {
  if (failedPayload === null) return null;
  const saved = learnerEntryAlreadyAppended(chatLog, learnerEntryForPayload(failedPayload));
  return saved ? failedPayload : null;
}
