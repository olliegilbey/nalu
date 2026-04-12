import { SM2, PROGRESSION } from "@/lib/config/tuning";
import {
  qualityScoreSchema,
  type SM2CardState,
  type SM2ReviewResult,
} from "@/lib/types/spaced-repetition";

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Default SM-2 state for a newly introduced concept. Matches the `concepts`
 * table column defaults in the DB schema.
 */
export const SM2_DEFAULTS: SM2CardState = {
  easinessFactor: SM2.initialEasinessFactor,
  interval: 0,
  repetitionCount: 0,
} as const;

/**
 * Apply the SM-2 easiness-factor adjustment, clamped at the floor.
 * Formula and constants live in `tuning.ts`.
 */
function adjustEasinessFactor(easinessFactor: number, quality: number): number {
  const { a, b, c } = SM2.efDelta;
  const delta = a - (5 - quality) * (b + (5 - quality) * c);
  const adjusted = easinessFactor + delta;
  return Math.max(adjusted, SM2.easinessFactorFloor);
}

/**
 * Compute the next interval (in days) for a successful review.
 *
 * Note: the spec multiplies by the OLD easiness factor (pre-adjustment).
 * This matches canonical SuperMemo SM-2 — do not "fix" to use the new EF.
 */
function nextIntervalOnSuccess(state: SM2CardState): number {
  if (state.repetitionCount === 0) return SM2.firstSuccessInterval;
  if (state.repetitionCount === 1) return SM2.secondSuccessInterval;
  return Math.round(state.interval * state.easinessFactor);
}

/**
 * SM-2 spaced repetition algorithm.
 *
 * Given a concept's current state and a freshly-scored quality, produce the
 * updated state and next-review timestamp. Pure — the caller persists.
 *
 * Success (quality ≥ passing) grows the interval and increments the
 * repetition count. Failure resets the repetition count to zero and
 * collapses the interval. The easiness factor is always adjusted.
 *
 * @param state - Current SM-2 state for the concept.
 * @param qualityScore - Integer 0-5 from LLM evaluation. Validated; throws on invalid.
 * @param now - Reference time for `nextReviewAt`. Injectable for testability.
 */
export function calculateSM2(
  state: SM2CardState,
  qualityScore: number,
  now: Date = new Date(),
): SM2ReviewResult {
  const quality = qualityScoreSchema.parse(qualityScore);

  const newEasinessFactor = adjustEasinessFactor(state.easinessFactor, quality);
  const isSuccess = quality >= PROGRESSION.passingQualityScore;

  const newInterval = isSuccess ? nextIntervalOnSuccess(state) : SM2.failureInterval;
  const newRepetitionCount = isSuccess ? state.repetitionCount + 1 : 0;
  const nextReviewAt = new Date(now.getTime() + newInterval * MILLISECONDS_PER_DAY);

  return {
    easinessFactor: newEasinessFactor,
    interval: newInterval,
    repetitionCount: newRepetitionCount,
    nextReviewAt,
  };
}
