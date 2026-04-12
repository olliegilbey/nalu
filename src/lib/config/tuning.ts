import type { QualityScore } from "@/lib/types/spaced-repetition";

/**
 * Single source of truth for every algorithm tunable in Nalu.
 *
 * If you want to adjust learning difficulty, XP rewards, spaced repetition
 * aggressiveness, or tier advancement strictness — this is the only file
 * you edit. Nothing else in the codebase should hardcode these values.
 *
 * Each export documents the source of its defaults so tweaks can be made
 * with full context.
 */

/**
 * SM-2 spaced repetition parameters.
 *
 * Source: SuperMemo SM-2 (Woźniak 1987). The EF adjustment formula is
 *   EF' = EF + (efDelta.a - (5 - q) * (efDelta.b + (5 - q) * efDelta.c))
 * clamped below at `easinessFactorFloor`.
 *
 * Intervals (in days) grow per the three-stage schedule:
 *   rep 0 → firstSuccessInterval
 *   rep 1 → secondSuccessInterval
 *   rep 2+ → round(previousInterval × oldEF)
 *
 * On failure the repetition count resets to 0 and the interval collapses
 * to `failureInterval`.
 */
export const SM2 = {
  initialEasinessFactor: 2.5,
  easinessFactorFloor: 1.3,
  firstSuccessInterval: 1,
  secondSuccessInterval: 6,
  failureInterval: 1,
  efDelta: { a: 0.1, b: 0.08, c: 0.02 },
} as const;

/**
 * XP reward configuration. Deterministic and hidden from the LLM — this is
 * the anti-gaming boundary. XP = round(tier × basePerTier × qualityMultiplier).
 *
 * Quality multipliers reward depth of understanding, not just correctness.
 * The 0-for-q1 rule punishes confident wrong answers more than silence.
 */
export const XP = {
  basePerTier: 10,
  qualityMultipliers: {
    0: 0, // no engagement / nonsensical
    1: 0, // wrong with clear misunderstanding
    2: 0.25, // wrong but partial understanding
    3: 0.75, // correct but uncertain or incomplete
    4: 1, // correct and clear
    5: 1.5, // deep understanding; could teach it
  },
} as const satisfies {
  readonly basePerTier: number;
  readonly qualityMultipliers: Readonly<Record<QualityScore, number>>;
};

/**
 * Tier advancement rules. Both conditions must be satisfied to unlock the
 * next tier. The minimum concept count is an anti-gaming measure — it
 * prevents a learner (or a broken LLM) from rushing through a tier with
 * only one or two easy concepts.
 */
export const PROGRESSION = {
  passingQualityScore: 3,
  minimumConceptsPerTier: 5,
  passingRatio: 0.8,
} as const;
