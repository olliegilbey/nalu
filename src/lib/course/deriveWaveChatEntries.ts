import type { ChatEntry } from "@/lib/types/chatEntry";
import { formatAnswers } from "./deriveChatEntries";
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";

/**
 * Project the wave's wire-redacted chat log to `ChatEntry[]` for the chat scroll.
 *
 * Pure. Single linear pass + one `findLastIndex` for the open-questionnaire
 * id resolution. No DB, no DOM.
 *
 * Algorithm:
 *   - The latest `assistant.text_with_questionnaire` whose id has no later
 *     `user.answers` is the OPEN questionnaire; only that entry emits
 *     `assistant-text-with-questionnaire`. Closed (already-answered) cards
 *     fall back to plain `assistant-text` (their prose still renders; the
 *     Composer never re-shows locked questionnaires).
 *   - `user.answers` formats via the shared `formatAnswers` helper, looking
 *     up the matching questionnaire's questions for prompt text. If the
 *     questionnaire isn't found (corrupt log), the helper falls back to
 *     `Q{n}` and renders something rather than crashing.
 *
 * `move-on-cta` is NOT emitted here — wave move-on is driven by
 * `useWaveState`'s `closeResult`, not by chat_log.
 */
export function deriveWaveChatEntries(
  log: readonly WaveChatLogEntryForClient[],
): readonly ChatEntry[] {
  // Open questionnaire id = latest text_with_questionnaire whose id has no
  // later user.answers match. Computed once; used inside the map.
  const lastQIdx = log.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
  // Mirrors findOpenQuestionnaire (server-shape twin); duplicated by design
  // because the two helpers run on different types (`WaveChatLogEntry` vs
  // `WaveChatLogEntryForClient`) — see plan T14.
  const openId = (() => {
    if (lastQIdx === -1) return null;
    const cand = log[lastQIdx];
    // Re-narrow for TS — findLastIndex predicate guarantees this shape at runtime.
    if (cand?.role !== "assistant" || cand.kind !== "text_with_questionnaire") return null;
    const answered = log
      .slice(lastQIdx + 1)
      .some(
        (e) =>
          e.role === "user" && e.kind === "answers" && e.questionnaireId === cand.questionnaireId,
      );
    return answered ? null : cand.questionnaireId;
  })();

  return log.map((entry, idx): ChatEntry => {
    if (entry.role === "user" && entry.kind === "text") {
      return { kind: "user-text", content: entry.content };
    }
    if (entry.role === "user" && entry.kind === "answers") {
      // formatAnswers takes the client question shape, so the redacted
      // questions pass straight through.
      // O(n) scan per user.answers entry → O(n²) overall. Bounded in practice
      // by WAVE.turnCount (~10-15 entries per wave); a Map would be faster
      // but isn't worth the line count at this scale.
      const qEntry = log
        .slice(0, idx)
        .find(
          (e) =>
            e.role === "assistant" &&
            e.kind === "text_with_questionnaire" &&
            e.questionnaireId === entry.questionnaireId,
        );
      const questions =
        qEntry?.role === "assistant" && qEntry.kind === "text_with_questionnaire"
          ? qEntry.questions
          : [];
      return {
        kind: "user-questionnaire-answers",
        content: formatAnswers(questions, entry.responses),
      };
    }
    if (entry.role === "assistant" && entry.kind === "text") {
      return { kind: "assistant-text", content: entry.content };
    }
    // entry.role === "assistant" && entry.kind === "text_with_questionnaire"
    if (entry.questionnaireId === openId) {
      return {
        kind: "assistant-text-with-questionnaire",
        content: entry.content,
        questionnaire: {
          questionnaireId: entry.questionnaireId,
          questions: entry.questions,
        },
      };
    }
    return { kind: "assistant-text", content: entry.content };
  });
}
