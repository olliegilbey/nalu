import { MC_OPTION_KEYS, type McOptionKey } from "@/lib/types/mcOptionKey";
import type { ChoiceQuestion } from "./adaptQuestionnaire";

/**
 * One entry in the answer payload submitted to questionnaire consumers
 * (`course.submitBaseline`, and the Wave turn route's
 * `questionnaire-answers` branch). Same wire shape across phases.
 */
export type ShapedQuestionnaireAnswer =
  | { readonly id: string; readonly kind: "mc"; readonly selected: McOptionKey }
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

/**
 * Index of the option an answer names verbatim, or null when it ships as free
 * text. The one MC-vs-free-text rule: the shaper below and the Composer's MC
 * XP award (issue #18) both call it, so the XP badge cannot drift from what
 * ships as MC.
 */
export function matchOptionIndex(question: ChoiceQuestion, answer: string): number | null {
  const idx = question.options.indexOf(answer);
  // Guard idx against MC_OPTION_KEYS.length explicitly — adaptQuestionnaire
  // emits one option per key for MC questions, but ChoiceQuestion.options is
  // typed as readonly string[], so a future schema change could overflow.
  return idx >= 0 && idx < MC_OPTION_KEYS.length ? idx : null;
}

/**
 * Shape Composer-emitted `{ question, answer }` pairs into the discriminated
 * union that questionnaire consumers expect (`submitBaseline` and the Wave
 * turn route's `questionnaire-answers` branch share this wire shape).
 *
 * MC vs free-text is disambiguated by `matchOptionIndex` — the Composer
 * returns the option text verbatim for taps, or the user's typed reply for
 * escape-hatch free-text. Questions with `options.length === 0` are always
 * free-text.
 *
 * Lives in `src/lib/` so the component layer stays a thin rendering shell.
 */
export function shapeQuestionnaireAnswers(
  answers: readonly RawComposerAnswer[],
): readonly ShapedQuestionnaireAnswer[] {
  return answers.map(({ question, answer }) => {
    const idx = matchOptionIndex(question, answer);
    const letter = idx === null ? undefined : MC_OPTION_KEYS[idx];
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
