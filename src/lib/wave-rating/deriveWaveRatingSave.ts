import type { SaveWaveRatingInput, WaveRatingStars } from "@/lib/types/waveRatingInput";

/** The rating step's state: every prompt starts blank, overall included. */
export type WaveRatingDraft = Partial<WaveRatingStars>;

/** One prompt on the rating step, by name: overall, difficulty, pacing or usefulness. */
export type WaveRatingPrompt = keyof WaveRatingStars;

/**
 * Whether the step shows the difficulty, pacing and usefulness prompts.
 * Only once overall holds a value: a blank step asks one question, so the
 * learner never faces a form.
 */
export function showsWaveRatingDetails(stars: WaveRatingDraft): boolean {
  return stars.overall !== undefined;
}

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
  // The draft holds only the prompts tapped, so the rest spread carries
  // each dimension given and no key for the others.
  const { overall, ...dimensions } = stars;
  if (overall === undefined) return null;
  return { courseId, waveNumber, ...dimensions, overall };
}
