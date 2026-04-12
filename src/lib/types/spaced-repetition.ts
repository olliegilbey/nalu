import { z } from "zod";

/**
 * Quality score assigned by the LLM after evaluating a learner's answer.
 *
 * Integer 0-5, where:
 * - 0: no engagement / nonsensical
 * - 1: incorrect with clear misunderstanding
 * - 2: incorrect, partial understanding
 * - 3: correct but uncertain or incomplete (minimum passing)
 * - 4: correct and clear
 * - 5: deep understanding; could teach it
 *
 * Validated at the LLM response trust boundary via `qualityScoreSchema`.
 */
export const qualityScoreSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type QualityScore = z.infer<typeof qualityScoreSchema>;

/**
 * Immutable SM-2 card state. Mirrors the SM-2 fields on the `concepts` DB row.
 * `interval` is in days; 0 means "never reviewed."
 */
export interface SM2CardState {
  readonly easinessFactor: number;
  readonly interval: number;
  readonly repetitionCount: number;
}

/**
 * Result of a single SM-2 review: new card state plus the computed next
 * review timestamp. The caller is responsible for persisting it.
 */
export interface SM2ReviewResult extends SM2CardState {
  readonly nextReviewAt: Date;
}
