import type { WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";
import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";

/**
 * The learner `chat_log` entry one Wave Turn's payload saves. Pure.
 *
 * `prepareWaveTurn` appends it before the LLM call and compares it with
 * `learnerEntryAlreadyAppended`. The client's Retry gate runs the same pair
 * (`deriveRetryableWaveTurn`), so one rule decides "same submission" on both
 * sides. Keep this client-safe: types-only imports.
 *
 * Responses keep the payload's answer order, so a re-send of the same
 * submission builds the identical array. `fromEscape` is not saved.
 */
export function learnerEntryForPayload(payload: SubmitTurnPayload): WaveChatLogEntry {
  if (payload.kind === "chat-text") {
    return { role: "user", kind: "text", content: payload.text };
  }
  return {
    role: "user",
    kind: "answers",
    questionnaireId: payload.questionnaireId,
    responses: payload.answers.map((a) =>
      a.kind === "mc"
        ? { questionId: a.id, choice: a.selected }
        : { questionId: a.id, freetext: a.text },
    ),
  };
}
