import { MC_OPTION_KEYS } from "@/lib/types/mcOptionKey";
import type { QuestionnaireAnswer } from "@/lib/types/questionnaireAnswer";
import type { ChoiceQuestion } from "./adaptQuestionnaire";

/** One raw `{ question, answer }` pair as emitted by the Composer. */
export interface RawComposerAnswer {
  readonly question: ChoiceQuestion;
  readonly answer: string;
}

/**
 * Index of the option an answer names verbatim, or null when it ships as free
 * text. The one MC-vs-free-text rule, used by the shaper below.
 */
export function matchOptionIndex(question: ChoiceQuestion, answer: string): number | null {
  const idx = question.options.indexOf(answer);
  // Guard idx against MC_OPTION_KEYS.length explicitly — adaptQuestionnaire
  // emits one option per key for MC questions, but ChoiceQuestion.options is
  // typed as readonly string[], so a future schema change could overflow.
  return idx >= 0 && idx < MC_OPTION_KEYS.length ? idx : null;
}

/**
 * Shape Composer-emitted `{ question, answer }` pairs into
 * {@link QuestionnaireAnswer}s, the wire shape both questionnaire consumers
 * parse (`submitBaseline` and the Wave turn route's `questionnaire-answers`
 * branch).
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
): readonly QuestionnaireAnswer[] {
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
