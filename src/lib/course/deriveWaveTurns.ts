import type { Turn } from "@/lib/types/turn";
import type { RenderedMessage } from "./getWaveState";
import type { OpenQuestionnaireForClient } from "./redactQuestionnaire";

/**
 * Project the wave's chat-visible message log + open questionnaire to `Turn[]`.
 *
 * Pure function: no DB, no DOM, no LLM. Deterministic given inputs.
 *
 * Algorithm (per-row walk, `messages` already sorted by `(turn_index, seq)`):
 *   - `user_message` → `{ kind: "user-text", content }`
 *   - `card_answer`  → `{ kind: "user-questionnaire-answers", content }`
 *   - `assistant_response` → `{ kind: "assistant-text", content }` —
 *     UNLESS this is the **latest** assistant_response AND `openQuestionnaire`
 *     is non-null AND its `questionnaireId` matches this row's id. In that
 *     case we emit `assistant-text-with-questionnaire`, attaching the
 *     redacted questionnaire so the Composer can render the cards.
 *
 * Why match by id, not just "any open questionnaire on the latest assistant
 * row": `loadWaveContext` reconstructs the open questionnaire from the latest
 * assistant_response and uses that row's id as `questionnaireId` (see
 * `loadWaveContext.ts:117`). A mismatch should never happen in practice, but
 * if it ever does (e.g. a future refactor) the defensive fallback to plain
 * `assistant-text` keeps the scroll renderable rather than silently dropping
 * the content.
 *
 * `move-on-cta` is NOT emitted here — the wave move-on CTA is driven from
 * `useWaveState`'s `closeResult`, rendered via the Composer's `moveOn` prop.
 */
export function deriveWaveTurns(
  messages: readonly RenderedMessage[],
  openQuestionnaire: OpenQuestionnaireForClient | null,
): readonly Turn[] {
  // Find the latest assistant_response index. We only attach the questionnaire
  // to THAT row (matching `loadWaveContext`'s reconstruction convention).
  const lastAssistantIdx = messages.findLastIndex((m) => m.kind === "assistant_response");

  return messages.map((row, idx): Turn => {
    if (row.kind === "user_message") {
      return { kind: "user-text", content: row.content };
    }
    if (row.kind === "card_answer") {
      return { kind: "user-questionnaire-answers", content: row.content };
    }
    // row.kind === "assistant_response"
    if (
      idx === lastAssistantIdx &&
      openQuestionnaire !== null &&
      openQuestionnaire.questionnaireId === row.id
    ) {
      return {
        kind: "assistant-text-with-questionnaire",
        content: row.content,
        questionnaire: {
          questions: openQuestionnaire.questions,
          questionnaireId: openQuestionnaire.questionnaireId,
        },
      };
    }
    return { kind: "assistant-text", content: row.content };
  });
}
