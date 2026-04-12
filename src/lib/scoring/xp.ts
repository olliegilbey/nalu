import { z } from "zod";
import { XP } from "@/lib/config/tuning";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

const tierSchema = z.int().min(1);

/**
 * Deterministic XP award for a single assessment.
 *
 *   XP = round(tier × XP.basePerTier × XP.qualityMultipliers[quality])
 *
 * This is the anti-gaming boundary: the LLM never sees or influences the
 * XP value. It returns only a quality score (0-5); the harness computes XP.
 *
 * Tuning values live in `src/lib/config/tuning.ts`.
 *
 * @param tier - Positive integer, the tier of the concept assessed.
 * @param qualityScore - Integer 0-5 from LLM evaluation. Validated; throws on invalid.
 * @returns XP awarded (non-negative integer).
 */
export function calculateXP(tier: number, qualityScore: number): number {
  const validatedTier = tierSchema.parse(tier);
  const validatedQuality = qualityScoreSchema.parse(qualityScore);

  // `validatedQuality` is a QualityScore literal, and the multipliers table
  // has an entry for every such value — the lookup is statically total.
  const multiplier = XP.qualityMultipliers[validatedQuality];
  return Math.round(validatedTier * XP.basePerTier * multiplier);
}
