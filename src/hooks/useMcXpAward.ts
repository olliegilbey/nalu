"use client";

import { useRef } from "react";
import type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import { deriveMcXpAward, type McXpAwardScope } from "@/lib/course/deriveMcXpAward";

/** Inputs of {@link useMcXpAward}: the card's award scope plus the XP sink. */
export interface UseMcXpAwardOptions extends McXpAwardScope {
  /** Receives the display XP. Routes to `useCourseXp.addXp`, which plays the correct-answer sound. */
  readonly onCorrectAnswer?: (amount: number) => void;
}

/**
 * Award a correct MC answer's display XP at most once per question per
 * questionnaire (issue #21). Returns the award function.
 *
 * A failed submit re-shows the card, and the restored buffer drops the final
 * answer, so the learner answers that question twice. The awarded set is a
 * ref, not state: it must outlive the card's buffer re-init, and it never
 * drives rendering.
 */
export function useMcXpAward({
  onCorrectAnswer,
  ...scope
}: UseMcXpAwardOptions): (question: ChoiceQuestion) => void {
  const awardedRef = useRef(new Set<string>());
  return (question) => {
    const award = deriveMcXpAward(question, scope);
    if (awardedRef.current.has(award.key)) return;
    awardedRef.current.add(award.key);
    onCorrectAnswer?.(award.amount);
  };
}
