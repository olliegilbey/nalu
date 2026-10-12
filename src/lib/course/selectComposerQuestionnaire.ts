import type { ActiveQuestionnaire, ChoiceQuestion } from "./adaptQuestionnaire";

/** The answer card a Wave's Composer shows: questions plus the buffer key that belongs to them. */
export interface ComposerQuestionnaire {
  readonly questions: readonly ChoiceQuestion[];
  /** localStorage key for the card's answer buffer. Absent for a streaming preview. */
  readonly persistKey?: string;
}

/**
 * Pick the answer card for a Wave's Composer. Pure.
 *
 * The committed questionnaire wins, unless the learner just submitted it
 * (`dismissedKey`). Then the next one's streaming preview shows, if any.
 *
 * Questions and buffer key always come from the same questionnaire. A
 * preview has no questionnaire id until its turn persists, so it gets no
 * key and never touches a buffer. Pairing it with the committed one's key
 * restored that questionnaire's answers into the next one whenever both
 * reused raw ids like `q1` (issue #118).
 */
export function selectComposerQuestionnaire(
  active: ActiveQuestionnaire | null,
  dismissedKey: string | null,
  streamingQuestions: readonly ChoiceQuestion[] | null,
): ComposerQuestionnaire | null {
  if (active && active.questionsKey !== dismissedKey) {
    return { questions: active.questions, persistKey: active.persistKey };
  }
  return streamingQuestions ? { questions: streamingQuestions } : null;
}
