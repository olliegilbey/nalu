import { adaptOpenQuestion, type ActiveQuestionnaire } from "./adaptQuestionnaire";
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";

/**
 * Derive the Composer's active questionnaire for a Wave from its chat log.
 *
 * The active questionnaire is the latest `assistant.text_with_questionnaire`
 * whose id has no later `user.answers` entry. Pure.
 */
export function deriveActiveQuestionnaire(
  chatLog: readonly WaveChatLogEntryForClient[],
  waveId: string,
): ActiveQuestionnaire | null {
  // Walk from the tail to find the most recent questionnaire emission;
  // `findLastIndex` is cleaner than reversing + indexing.
  const lastQIdx = chatLog.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
  if (lastQIdx === -1) return null;
  const lastQ = chatLog[lastQIdx];
  // Re-narrow for TS — findLastIndex predicate guarantees this shape at runtime.
  if (lastQ?.role !== "assistant" || lastQ.kind !== "text_with_questionnaire") return null;
  // Any later `user.answers` entry referencing this questionnaire's id
  // means it's been submitted → no active questionnaire.
  const answered = chatLog
    .slice(lastQIdx + 1)
    .some(
      (e) =>
        e.role === "user" && e.kind === "answers" && e.questionnaireId === lastQ.questionnaireId,
    );
  if (answered) return null;
  return {
    kind: "wave",
    questions: lastQ.questions.map(adaptOpenQuestion),
    // The questionnaireId doubles as the Composer reset key, and
    // `submitQuestionnaireAnswers` echoes it back to the server.
    questionsKey: lastQ.questionnaireId,
    persistKey: `nalu:wave:${waveId}:q:${lastQ.questionnaireId}`,
  };
}
