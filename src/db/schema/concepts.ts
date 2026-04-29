import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { courses } from "./courses";

/**
 * `concepts` — per-course learning items with SM-2 spaced-repetition state
 * (spec §3.6).
 *
 * `tier` is set at first sighting and is immutable thereafter (spec §3
 * decisions). If the model emits a differing tier on a later Wave, the
 * existing tier wins on upsert — the new value is treated as a slip.
 *
 * Dedup is strict-natural-key via `UNIQUE (course_id, lower(name))`. The
 * model is told existing concept names in each Wave seed so collisions are
 * rare. Drift reconciliation is post-MVP.
 *
 * Partial index `concepts_due_idx` targets the hottest read path (Wave-start
 * due-concepts query). Never-reviewed rows have NULL `next_review_at` and are
 * excluded from the index to keep it small.
 */
export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    tier: integer("tier").notNull(),
    // SM-2 starting easiness factor; 2.5 is the canonical default from the algorithm.
    easinessFactor: real("easiness_factor").notNull().default(2.5),
    // Days until next review; 0 means the concept is due immediately.
    intervalDays: integer("interval_days").notNull().default(0),
    // How many successful review cycles have occurred.
    repetitionCount: integer("repetition_count").notNull().default(0),
    // Quality score (0–5) of the most recent review, null when never reviewed.
    lastQualityScore: integer("last_quality_score"),
    // Timestamp of the most recent review, null when never reviewed.
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    // When this concept is next due for review, null when never reviewed.
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    timesCorrect: integer("times_correct").notNull().default(0),
    timesIncorrect: integer("times_incorrect").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Case-insensitive natural-key dedup per course; lets upsert use lower(name) without storing a normalised column.
    uniqueIndex("concepts_course_name_lower_unique").on(t.courseId, sql`lower(${t.name})`),
    // Partial index on (course_id, next_review_at) WHERE next_review_at IS NOT NULL; powers the Wave-start due-concepts query, and the partial filter keeps the index small because never-reviewed rows are excluded.
    index("concepts_due_idx")
      .on(t.courseId, t.nextReviewAt)
      .where(sql`${t.nextReviewAt} IS NOT NULL`),
    // Supports tier-scoped reads when the framework asks for concepts at a given tier.
    index("concepts_course_tier_idx").on(t.courseId, t.tier),
  ],
);

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type Concept = InferSelectModel<typeof concepts>;

/**
 * Shape for INSERT statements.
 *
 * Required (notNull, no default): `courseId`, `name`, `tier`.
 *
 * Optional with server defaults: `id` (defaultRandom), `easinessFactor`
 * (default 2.5 — SM-2 starting EF), `intervalDays` (default 0),
 * `repetitionCount` (default 0), `timesCorrect` (default 0),
 * `timesIncorrect` (default 0), `firstSeenAt` (defaultNow).
 *
 * Nullable (no default): `description`, `lastQualityScore`,
 * `lastReviewedAt`, `nextReviewAt` — null means "never reviewed yet";
 * the partial index `concepts_due_idx` deliberately excludes these rows.
 */
export type ConceptInsert = InferInsertModel<typeof concepts>;

/** Zod schema for validating insert payloads at trust boundaries (e.g. API input). */
export const conceptsInsertSchema = createInsertSchema(concepts);

/** Zod schema for validating rows read from the DB. */
export const conceptsSelectSchema = createSelectSchema(concepts);
