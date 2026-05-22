import type { RawComposerAnswer } from "./shapeQuestionnaireAnswers";

/**
 * Format Composer-emitted `{ question, answer }` pairs as the same numbered
 * prose list that `formatAnswers` (`deriveTurns.ts`) produces from persisted
 * responses: `"{n}. {prompt} — {answer}"` joined by newlines.
 *
 * Used to render the *optimistic* user-answers bubble the instant a
 * questionnaire is submitted, before the server round-trip lands. Matching the
 * persisted formatter exactly keeps the optimistic text identical to the
 * refetched turn, so there is no visible swap when real data arrives.
 */
export function formatComposerAnswers(answers: readonly RawComposerAnswer[]): string {
  return answers.map((a, i) => `${i + 1}. ${a.question.prompt} — ${a.answer}`).join("\n");
}
