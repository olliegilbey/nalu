import type { QualityScore } from "@/lib/types/spaced-repetition";

/**
 * Minimal concept state needed for tier advancement checks — just the most
 * recent quality score per concept in the current tier.
 */
export interface ConceptState {
  readonly lastQualityScore: QualityScore;
}

/**
 * Result of `checkTierAdvancement`. A boolean alone is insufficient: the UI
 * renders partial progress ("4/5 concepts passing, need 1 more"), so we
 * return the underlying counts and ratios too.
 */
export interface TierAdvancementResult {
  readonly canAdvance: boolean;
  readonly totalConcepts: number;
  readonly passingConcepts: number;
  readonly passingPercentage: number;
  readonly minimumConceptsMet: boolean;
}
