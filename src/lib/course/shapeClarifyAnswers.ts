import type { RawComposerAnswer } from "./shapeBaselineAnswers";

/** One entry in the answer payload submitted to `course.submitClarify`. */
export interface ShapedClarifyAnswer {
  readonly questionId: string;
  readonly freetext: string;
}

/**
 * Shape Composer-emitted `{ question, answer }` pairs into the
 * `course.submitClarify` payload (always free-text — clarify never has MC).
 *
 * Lives in `src/lib/` so the component layer stays a thin rendering shell;
 * parallels `shapeBaselineAnswers` for symmetry.
 */
export function shapeClarifyAnswers(
  answers: readonly RawComposerAnswer[],
): readonly ShapedClarifyAnswer[] {
  return answers.map(({ question, answer }) => ({
    questionId: question.id,
    freetext: answer,
  }));
}
