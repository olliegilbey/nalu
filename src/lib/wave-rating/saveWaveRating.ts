import { TRPCError } from "@trpc/server";
import { getCourseById, NotFoundError } from "@/db/queries/courses";
import { getWaveByCourseAndNumber } from "@/db/queries/waves";
import { upsertWaveRating } from "@/db/queries/waveRatings";
import { captureWaveRated } from "@/lib/analytics/captureWaveRated";
import type { WaveRatingStars } from "@/lib/types/waveRatingInput";

/** Input to {@link saveWaveRating}. `userId` enforces ownership; the stars arrive parsed. */
export interface SaveWaveRatingParams {
  readonly userId: string;
  readonly courseId: string;
  readonly waveNumber: number;
  readonly stars: WaveRatingStars;
}

/** The stars as stored. A dimension the save omitted is null. */
export interface StoredWaveRatingStars {
  readonly overall: number;
  readonly difficulty: number | null;
  readonly pacing: number | null;
  readonly usefulness: number | null;
}

/**
 * Save the learner's rating of one closed Wave and return the stored stars.
 *
 * Guards, in order:
 *   1. The Wave exists, and its course belongs to `userId`. Either miss
 *      fails NOT_FOUND with one message, as in `getWaveState`, so it never
 *      discloses another learner's course.
 *   2. The Wave is closed, or it fails PRECONDITION_FAILED. A rating always
 *      describes a finished Wave.
 * Then it upserts the row and schedules one `wave_rated` event. A refusal
 * writes nothing and sends nothing.
 *
 * Feedback, never score: it reads and writes nothing else. No XP, SM-2,
 * tier, Context or chat-log write. No log line carries the stars.
 */
export async function saveWaveRating(params: SaveWaveRatingParams): Promise<StoredWaveRatingStars> {
  const { userId, courseId, waveNumber, stars } = params;
  const notFound = () =>
    new TRPCError({
      code: "NOT_FOUND",
      message: `wave ${waveNumber} not found for course ${courseId}`,
    });

  // (1) Resolve the Wave, then check ownership. `getCourseById` throws
  // `NotFoundError` on a missing course or another owner's alike.
  const wave = await getWaveByCourseAndNumber(courseId, waveNumber);
  if (!wave) throw notFound();
  await getCourseById(courseId, userId).catch((err: unknown): never => {
    if (err instanceof NotFoundError) throw notFound();
    throw err;
  });

  // (2) Only a closed Wave takes a rating. The message quotes ids and
  // statuses only: it reaches the learner's toast.
  if (wave.status !== "closed") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `wave ${waveNumber} is not closed`,
    });
  }

  // (3) One statement, so it has committed once it returns. (4) Only then
  // schedule the event; the capture never throws, so it cannot fail the save.
  const row = await upsertWaveRating({ waveId: wave.id, ...stars });
  captureWaveRated({ userId, waveNumber, stars });

  return {
    overall: row.overall,
    difficulty: row.difficulty,
    pacing: row.pacing,
    usefulness: row.usefulness,
  };
}
