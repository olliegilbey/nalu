import type { WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";
import type { OpenQuestionnaireRecord } from "./buildLearnerInput";

/**
 * Find the currently-open questionnaire on a wave, or null if none.
 *
 * Open = the latest `assistant.text_with_questionnaire` entry whose
 * `questionnaireId` is NOT referenced by any later `user.answers` entry. Pure;
 * a single linear scan. Replaces the deleted
 * `loadWaveContext.reconstructOpenQuestionnaire` (which re-parsed envelope
 * JSON from `context_messages.content` — see ARCHITECTURE.md for why that
 * envelope-read coupling went away).
 *
 * Produces an `OpenQuestionnaireRecord` (the server-side shape used by
 * `buildLearnerInput` for envelope rendering and by `executeWaveMid` for
 * mechanical MC correctness). The wire-side projection
 * (`WaveChatLogEntryForClient`) is computed separately by
 * `redactWaveChatLog`.
 */
export function findOpenQuestionnaire(
  log: readonly WaveChatLogEntry[],
): OpenQuestionnaireRecord | null {
  // Walk from the end. Identity of the open questionnaire is determined by
  // whichever text_with_questionnaire is latest AND lacks a later answers entry.
  const lastQIdx = log.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
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
  if (answered) return null;

  // Project to the server-side record shape. MC carries `correct` (server-
  // side truth); the wire-redaction path computes correctEnc elsewhere.
  const questions = cand.questions.map((q) => {
    if (q.type === "multiple_choice") {
      return {
        id: q.id,
        type: "multiple_choice" as const,
        prompt: q.prompt,
        options: q.options,
        correct: q.correct,
        freetextRubric: q.freetextRubric,
      };
    }
    return {
      id: q.id,
      type: "free_text" as const,
      prompt: q.prompt,
      freetextRubric: q.freetextRubric,
    };
  });
  return { questionnaireId: cand.questionnaireId, questions };
}
