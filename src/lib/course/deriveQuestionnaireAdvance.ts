import { replaceAt } from "@/lib/utils";
import type { ChoiceQuestion } from "./adaptQuestionnaire";
import type { RawComposerAnswer } from "./shapeQuestionnaireAnswers";

/** The answer card's state when the learner records one answer. */
export interface QuestionnaireAdvanceInput {
  readonly questions: readonly ChoiceQuestion[];
  /** Recorded answers, indexed by question; `null` while unanswered. */
  readonly answers: readonly (string | null)[];
  /** Live free-text drafts, indexed by question. */
  readonly drafts: readonly string[];
  /** The question being answered. */
  readonly questionIndex: number;
  /** The answer to record: an MC option's text, or typed text. */
  readonly answer: string;
}

/** What recording one answer does: finish the card, or move to another question. */
export type QuestionnaireAdvance =
  | {
      readonly kind: "complete";
      readonly answers: readonly (string | null)[];
      /** One `{ question, answer }` pair per question, ready for `onComplete`. */
      readonly completed: readonly RawComposerAnswer[];
    }
  | {
      readonly kind: "advance";
      readonly answers: readonly (string | null)[];
      readonly nextIndex: number;
    };

/**
 * Record one answer and decide where the answer card goes next. Pure.
 *
 * The card completes once every question has an answer. Otherwise it moves to
 * the following question, or, from the last one, wraps to the first gap.
 */
export function deriveQuestionnaireAdvance(input: QuestionnaireAdvanceInput): QuestionnaireAdvance {
  const { questions, drafts, questionIndex, answer } = input;
  const answers = replaceAt(input.answers, questionIndex, answer);

  if (answers.every((a) => a != null)) {
    return {
      kind: "complete",
      answers,
      completed: questions.map((question, i) => ({
        question,
        // Free-text questions stay editable, so the live draft — not the
        // answer recorded at send time — is the source of truth, picking up
        // any back-edits. Fall back to the recorded answer if the draft was
        // blanked. MC questions use the recorded option text.
        answer: question.options.length === 0 ? drafts[i]?.trim() || answers[i]! : answers[i]!,
      })),
    };
  }

  // Not complete, so some other question is still unanswered: the wrap from
  // the last question always finds a gap.
  const nextIndex =
    questionIndex < questions.length - 1
      ? questionIndex + 1
      : answers.findIndex((a, i) => i !== questionIndex && a == null);
  return { kind: "advance", answers, nextIndex };
}
