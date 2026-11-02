import { pgTable, uuid, integer, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { waves } from "./waves";

/**
 * `wave_ratings` — the learner's rating of one closed Wave (issue #259).
 * One row per rated Wave.
 *
 * Learner feedback, never score: no XP, SM-2, tier, Context or prompt code
 * reads it. Ownership runs Wave → course → learner, so the row holds no user
 * id. A save upserts the whole row: a dimension the latest save omits is
 * stored null, and `rated_at` moves to that save.
 *
 * Each star column holds 1 to 5, the bound `saveWaveRatingInputSchema` parses
 * (`WAVE_RATING_STAR_COUNT`). A CHECK passes on null, so the nullable
 * dimensions need no extra clause.
 */
export const waveRatings = pgTable(
  "wave_ratings",
  {
    waveId: uuid("wave_id")
      .primaryKey()
      .references(() => waves.id, { onDelete: "cascade" }),
    overall: integer("overall").notNull(),
    difficulty: integer("difficulty"),
    pacing: integer("pacing"),
    usefulness: integer("usefulness"),
    ratedAt: timestamp("rated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("wave_ratings_overall_range", sql`${t.overall} BETWEEN 1 AND 5`),
    check("wave_ratings_difficulty_range", sql`${t.difficulty} BETWEEN 1 AND 5`),
    check("wave_ratings_pacing_range", sql`${t.pacing} BETWEEN 1 AND 5`),
    check("wave_ratings_usefulness_range", sql`${t.usefulness} BETWEEN 1 AND 5`),
  ],
).enableRLS();

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type WaveRating = InferSelectModel<typeof waveRatings>;
