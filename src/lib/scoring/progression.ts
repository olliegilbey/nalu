import { PROGRESSION } from "@/lib/config/tuning";
import type { ConceptState, TierAdvancementResult } from "@/lib/types/scoring";

/**
 * Can the learner advance from their current tier?
 *
 * Two conditions, both required (tuning values in `config/tuning.ts`):
 *   1. At least `PROGRESSION.minimumConceptsPerTier` assessed concepts.
 *   2. At least `PROGRESSION.passingRatio` fraction of those concepts have
 *      `lastQualityScore >= PROGRESSION.passingQualityScore`.
 *
 * Returns a rich result so the UI can render partial progress. Caller is
 * responsible for filtering concepts to the current tier before calling.
 */
export function checkTierAdvancement(
  conceptStates: readonly ConceptState[],
): TierAdvancementResult {
  const totalConcepts = conceptStates.length;
  const passingConcepts = conceptStates.filter(
    (c) => c.lastQualityScore >= PROGRESSION.passingQualityScore,
  ).length;
  const passingPercentage = totalConcepts === 0 ? 0 : passingConcepts / totalConcepts;

  const minimumConceptsMet = totalConcepts >= PROGRESSION.minimumConceptsPerTier;
  const canAdvance = minimumConceptsMet && passingPercentage >= PROGRESSION.passingRatio;

  return {
    canAdvance,
    totalConcepts,
    passingConcepts,
    passingPercentage,
    minimumConceptsMet,
  };
}
