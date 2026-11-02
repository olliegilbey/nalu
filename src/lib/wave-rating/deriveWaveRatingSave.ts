import type { SaveWaveRatingInput, WaveRatingStars } from "@/lib/types/waveRatingInput";

/** The rating step's state: every prompt starts blank, overall included. */
export type WaveRatingDraft = Partial<WaveRatingStars>;

/**
 * Decide what move-on saves for one Wave. No overall rating means no save:
 * the learner rated nothing, so it returns null. Otherwise it returns the
 * `wave.saveRating` input, carrying only the stars the learner gave.
 */
export function deriveWaveRatingSave({
  courseId,
  waveNumber,
  stars,
}: {
  readonly courseId: string;
  readonly waveNumber: number;
  readonly stars: WaveRatingDraft;
}): SaveWaveRatingInput | null {
  const { overall, ...dimensions } = stars;
  if (overall === undefined) return null;
  return { courseId, waveNumber, ...dimensions, overall };
}
