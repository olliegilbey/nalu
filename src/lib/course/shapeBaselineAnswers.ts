import type { ChoiceQuestion } from "./adaptQuestionnaire";

/** One entry in the answer payload submitted to `course.submitBaseline`. */
export type ShapedBaselineAnswer =
  | { readonly id: string; readonly kind: "mc"; readonly selected: "A" | "B" | "C" | "D" }
  | {
      readonly id: string;
      readonly kind: "freetext";
      readonly text: string;
      readonly fromEscape: boolean;
    };

/** One raw `{ question, answer }` pair as emitted by the Composer. */
export interface RawComposerAnswer {
  readonly question: ChoiceQuestion;
  readonly answer: string;
}

const LETTERS = ["A", "B", "C", "D"] as const;

/**
 * Shape Composer-emitted `{ question, answer }` pairs into the discriminated
 * union the `course.submitBaseline` procedure expects.
 *
 * MC vs free-text is disambiguated by matching the answer string against the
 * question's options array — the Composer returns the option text verbatim
 * for taps, or the user's typed reply for escape-hatch free-text. Questions
 * with `options.length === 0` are always free-text.
 *
 * Lives in `src/lib/` so the component layer stays a thin rendering shell.
 */
export function shapeBaselineAnswers(
  answers: readonly RawComposerAnswer[],
): readonly ShapedBaselineAnswer[] {
  return answers.map(({ question, answer }) => {
    const idx = question.options.indexOf(answer);
    // Guard idx against LETTERS.length explicitly — adaptQuestionnaire currently
    // emits exactly 4 options for MC questions, but ChoiceQuestion.options is
    // typed as readonly string[], so a future schema change could overflow.
    const letter = idx >= 0 && idx < LETTERS.length ? LETTERS[idx] : undefined;
    if (letter !== undefined) {
      return { id: question.id, kind: "mc", selected: letter };
    }
    return {
      id: question.id,
      kind: "freetext",
      text: answer,
      // fromEscape = the question HAS options but the user typed instead of tapping.
      fromEscape: question.options.length > 0,
    };
  });
}
