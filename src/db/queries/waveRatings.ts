import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { waveRatings, type WaveRating } from "@/db/schema";

/**
 * `wave_ratings` query surface: learner feedback on closed Waves. No JSONB on
 * this table, so no Zod row guard beyond the column types; the star CHECKs
 * hold each value to 1-5.
 */

/** Input to {@link upsertWaveRating}: one Wave's id and the stars given. */
export interface UpsertWaveRatingParams {
  readonly waveId: string;
  readonly overall: number;
  readonly difficulty?: number;
  readonly pacing?: number;
  readonly usefulness?: number;
}

/**
 * Save one Wave's rating and return the stored row. A later save replaces
 * the earlier one whole: every star column takes the submitted value, and a
 * dimension the save omits is stored null. `rated_at` moves to this save.
 *
 * The conflict target is the `wave_id` primary key, a column reference, so
 * Drizzle's `onConflictDoUpdate` takes it (the expression-target gotcha in
 * this folder's CLAUDE.md does not apply). `.returning()` on the builder maps
 * camelCase, unlike raw `RETURNING *`.
 */
export async function upsertWaveRating(params: UpsertWaveRatingParams): Promise<WaveRating> {
  const stars = {
    overall: params.overall,
    difficulty: params.difficulty ?? null,
    pacing: params.pacing ?? null,
    usefulness: params.usefulness ?? null,
  };
  const [row] = await db
    .insert(waveRatings)
    .values({ waveId: params.waveId, ...stars })
    .onConflictDoUpdate({
      target: waveRatings.waveId,
      set: { ...stars, ratedAt: sql`now()` },
    })
    .returning();
  // An upsert always returns its row on success.
  if (!row) throw new Error("upsertWaveRating: upsert returned no row");
  return row;
}
