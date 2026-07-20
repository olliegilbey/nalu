import { adaptOpenQuestion } from "./adaptQuestionnaire";
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";
import type { ActiveQuestionnaire } from "@/hooks/useScopingState";

/**
 * Derive the Composer's active questionnaire for a wave from its chat log.
 *
 * The active questionnaire is the latest `assistant.text_with_questionnaire`
 * whose id has no later `user.answers` entry. Mirrors `useScopingState`'s
 * derivation pattern — same `ActiveQuestionnaire` shape, same
 * questionnaireId-as-key identity for Composer state reset.
 *
 * Pure. Extracted from `useWaveState`'s `activeQuestionnaire` memo; the hook
 * keeps a thin `useMemo` wrapper that guards on `state.data` before calling.
 */
export function deriveActiveQuestionnaire(
  chatLog: readonly WaveChatLogEntryForClient[],
  waveId: string,
): ActiveQuestionnaire | null {
  const log = chatLog;
  // Walk from the tail to find the most recent questionnaire emission;
  // `findLastIndex` is cleaner than reversing + indexing.
  const lastQIdx = log.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
  if (lastQIdx === -1) return null;
  const lastQ = log[lastQIdx];
  // Re-narrow for TS — findLastIndex predicate guarantees this shape at runtime.
  if (lastQ?.role !== "assistant" || lastQ.kind !== "text_with_questionnaire") return null;
  // Any later `user.answers` entry referencing this questionnaire's id
  // means it's been submitted → no active questionnaire.
  const answered = log
    .slice(lastQIdx + 1)
    .some(
      (e) =>
        e.role === "user" && e.kind === "answers" && e.questionnaireId === lastQ.questionnaireId,
    );
  if (answered) return null;
  return {
    kind: "wave",
    questions: lastQ.questions.map(adaptOpenQuestion),
    questionsKey: lastQ.questionnaireId,
    persistKey: `nalu:wave:${waveId}:q:${lastQ.questionnaireId}`,
  };
}
