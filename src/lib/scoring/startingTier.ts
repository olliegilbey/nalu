import { BASELINE } from "@/lib/config/tuning";
import { verdictForQualityScore } from "@/lib/scoring/verdictBand";
import type { QualityScore } from "@/lib/types/spaced-repetition";

/** One graded baseline answer, filed under its question's tier. */
export interface BaselineTierResult {
  /**
   * The question's tier, fixed when the baseline was generated. Not the
   * grading's `conceptTier`: the model emits that after reading the answer.
   */
  readonly tier: number;
  /** Mechanical for an MC click; the close turn's grade for free text. */
  readonly qualityScore: QualityScore;
}

/** Inputs to {@link determineStartingTier}. */
export interface DetermineStartingTierParams {
  /** One entry per baseline question. */
  readonly results: readonly BaselineTierResult[];
  /** `framework.baselineScopeTiers`: the tiers placement may choose from. */
  readonly scopeTiers: readonly number[];
}

/**
 * The tier Wave 1 starts at, computed from the baseline results. The model
 * grades free-text answers but never picks the tier, so a learner cannot
 * talk their way to a higher one (issue #94).
 *
 * Walk the in-scope tiers from lowest to highest. A tier is mastered when
 * the share of its answers in the `correct` band (quality 4-5) is at least
 * `BASELINE.tierMasteryRatio`. Start at the first tier not mastered. A tier
 * with no answers is not mastered: no evidence, no skip. If every tier is
 * mastered, start at the highest. The result is always an in-scope tier.
 *
 * @throws if `scopeTiers` is empty.
 */
export function determineStartingTier(params: DetermineStartingTierParams): number {
  const ascending = [...params.scopeTiers].sort((a, b) => a - b);
  const highest = ascending.at(-1);
  if (highest === undefined) {
    throw new Error("determineStartingTier: scopeTiers is empty; placement needs a scope");
  }
  const firstNotMastered = ascending.find(
    (tier) => !isTierMastered(params.results.filter((r) => r.tier === tier)),
  );
  return firstNotMastered ?? highest;
}

/** True when enough of one tier's answers are correct. An empty tier is not mastered. */
function isTierMastered(tierResults: readonly BaselineTierResult[]): boolean {
  if (tierResults.length === 0) return false;
  // Correctness comes from the score, as for every graded answer (issue #198).
  const correct = tierResults.filter(
    (r) => verdictForQualityScore(r.qualityScore) === "correct",
  ).length;
  return correct / tierResults.length >= BASELINE.tierMasteryRatio;
}
