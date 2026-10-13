import { calculateMcXp } from "@/lib/scoring/xp";
import type { ChoiceQuestion } from "./adaptQuestionnaire";
import { matchOptionIndex } from "./shapeQuestionnaireAnswers";

/** The answer card a question sits on, for scoping its MC XP award. */
export interface McXpAwardScope {
  /** The card's buffer key, unique per questionnaire. Absent on a preview. */
  readonly persistKey?: string;
  /** The card's question ids joined; stands in for a missing buffer key. */
  readonly questionsKey: string;
  /** Wave tier — fallback when a question carries no tier of its own. */
  readonly waveTier?: number;
}

/** One correct MC answer's display XP, and the key that stops it awarding twice. */
export interface McXpAward {
  readonly key: string;
  readonly amount: number;
}

/**
 * Display XP for a correct MC answer, plus its once-only award key. Pure.
 *
 * This feeds the header badge only; the server owns the real total. The key
 * is scoped to the questionnaire: a Wave's questionnaires reuse raw ids like
 * `q1`, so the id alone would block the next one's award (#21).
 */
export function deriveMcXpAward(question: ChoiceQuestion, scope: McXpAwardScope): McXpAward {
  return {
    key: `${scope.persistKey ?? scope.questionsKey}:${question.id}`,
    // The question's own tier, else the Wave tier, else tier 1.
    amount: calculateMcXp(question.tier ?? scope.waveTier ?? 1, true),
  };
}

/**
 * Whether typed text earns MC XP: it names the correct option verbatim. Pure.
 *
 * Verbatim option text ships as an MC answer (`matchOptionIndex`, shared with
 * the shaper), and the server grades it as one. The turn result skips MC XP,
 * so the Composer awards it, as Confirm would (#18). An ungraded or free-text
 * question has no `correctIndex`, so nothing typed matches it.
 */
export function isTypedCorrectMcAnswer(question: ChoiceQuestion, answer: string): boolean {
  return matchOptionIndex(question, answer) === question.correctIndex;
}
