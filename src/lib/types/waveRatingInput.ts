import { z } from "zod/v4";

/**
 * Stars on every Wave rating prompt. More is better. The UI renders this many
 * stars; the `wave_ratings` CHECKs hold each column to 1 through this value.
 */
export const WAVE_RATING_STAR_COUNT = 5;

/** One star value: a whole number from 1 to {@link WAVE_RATING_STAR_COUNT}. */
const starSchema = z.number().int().min(1).max(WAVE_RATING_STAR_COUNT);

/**
 * Input schema for `wave.saveRating`: the one rule for a valid Wave rating.
 * It addresses the Wave as `wave.getState` does, by course id and Wave
 * number. Overall is required: a save exists only once the learner gives it.
 * The three dimensions are optional. A bad star fails the parse, so tRPC
 * answers BAD_REQUEST and nothing is written.
 */
export const saveWaveRatingInputSchema = z.object({
  courseId: z.uuid(),
  waveNumber: z.number().int().min(1),
  overall: starSchema,
  difficulty: starSchema.optional(),
  pacing: starSchema.optional(),
  usefulness: starSchema.optional(),
});

/** A parsed `wave.saveRating` input: the Wave's address plus the stars given. */
export type SaveWaveRatingInput = z.infer<typeof saveWaveRatingInputSchema>;

/** The stars of one Wave rating: overall, plus each dimension the learner gave. */
export type WaveRatingStars = Omit<SaveWaveRatingInput, "courseId" | "waveNumber">;
