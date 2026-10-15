import { adaptStreamedToolQuestion, type ChoiceQuestion } from "./adaptQuestionnaire";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";

/** One part of an in-flight Wave turn's assistant message. */
type WaveTurnPart = WaveTurnUIMessage["parts"][number];

/** A `presentQuestionnaire` tool part whose full (redacted) input has arrived. */
type QuestionnairePartWithInput = Extract<
  WaveTurnPart,
  { type: "tool-presentQuestionnaire"; state: "input-available" | "output-available" }
>;

/** The in-flight Wave turn as the Composer renders it, before the committed turn replaces it. */
export interface StreamingTurn {
  /**
   * In-flight assistant prose, growing token by token. Empty when idle. The
   * committed turn (from `wave.getState` after the finish refetch) replaces it.
   */
  readonly streamingText: string;
  /**
   * Questions streamed in the live attempt's first valid
   * `tool-presentQuestionnaire` part (generative UI). Non-null from that
   * part's `input-available` state until the committed
   * `activeQuestionnaire` takes over after the turn-result refetch. The
   * Composer renders them as a preview only; interactivity comes with
   * `activeQuestionnaire` (isPending disables the option grid until then).
   */
  readonly streamingQuestions: readonly ChoiceQuestion[] | null;
}

/**
 * Derive the in-flight Wave turn from `useChat`'s transient messages. Pure.
 *
 * Reads only the last assistant message, and only its live attempt: a
 * validation retry re-streams the whole turn, and the server marks the
 * boundary with a NON-transient `data-turn-reset` part. Everything before the
 * last reset is a failed attempt's output (stale text and tool parts).
 * TextUIPart carries no id, so slicing on the marker's POSITION is the only
 * reliable seam; `setMessages` surgery mid-stream is undone by the SDK's next
 * chunk.
 */
export function deriveStreamingTurn(messages: readonly WaveTurnUIMessage[]): StreamingTurn {
  const lastAssistant = messages.findLast((m) => m.role === "assistant");
  const allParts = lastAssistant?.parts ?? [];
  const lastResetIdx = allParts.findLastIndex((p) => p.type === "data-turn-reset");
  const liveParts = lastResetIdx === -1 ? allParts : allParts.slice(lastResetIdx + 1);

  // In-flight prose: the live attempt's text parts, concatenated.
  const streamingText = liveParts
    .filter((p): p is Extract<WaveTurnPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

  // In-flight questionnaire: the FIRST typed `tool-presentQuestionnaire` part
  // with input. Shown only from `input-available` onward: the server forwards
  // no input-streaming deltas. An invalid call lands as an `output-error`
  // part, and the model may self-correct in-loop with a second call, so
  // errored parts are skipped (issue #117). The tool commits the first valid
  // call and refuses later ones (`waveTurnTools.ts`), so the first valid
  // part is the one the committed card shows. The input the server forwards
  // is the redacted projection (grading keys stripped, see `streamWaveTurn`),
  // a structural subset of the typed input, hence the StreamedToolQuestion
  // adapter. It is the only tool part the server forwards: grading signals
  // and lookups stay server-side (issue #59).
  const questionnairePart = liveParts.find(
    (p): p is QuestionnairePartWithInput =>
      p.type === "tool-presentQuestionnaire" &&
      (p.state === "input-available" || p.state === "output-available"),
  );
  const streamingQuestions = questionnairePart
    ? questionnairePart.input.questions.map(adaptStreamedToolQuestion)
    : null;

  return { streamingText, streamingQuestions };
}
