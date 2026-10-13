import type { ChoiceQuestion } from "./adaptQuestionnaire";

/**
 * Identity of a question set: its question ids joined with `|`. Pure.
 *
 * Scopes the answer buffer saved in the learner's browser, and dismisses a
 * scoping card. Keep the format byte-stable: a change orphans every saved
 * buffer. Not unique on its own: Wave questionnaires reuse raw ids, so the
 * Composer pairs it with `persistKey` (#118).
 */
export function questionnaireKey(questions: readonly Pick<ChoiceQuestion, "id">[]): string {
  return questions.map((q) => q.id).join("|");
}
