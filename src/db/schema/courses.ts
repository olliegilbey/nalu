import { pgTable, uuid, text, integer, timestamp, jsonb, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { userProfiles } from "./userProfiles";

/**
 * `courses` — one row per learner-topic pairing (spec §3.2).
 *
 * Scoping outputs (`clarification`, `framework`, `baseline`, `starting_tier`)
 * are immutable once scoping closes. `current_tier` is mutable post-scoping
 * via `progression.ts` (promotion or demotion).
 *
 * `summary` is the cumulative LLM-rewritten course summary, seeded from the
 * baseline batch evaluation's `<course_summary>` and overwritten on every
 * Wave close via `<course_summary_update>`.
 *
 * `total_xp` is a cached aggregate (see §3 decisions) — reconciled from
 * `assessments.xp_awarded`.
 */
export const courses = pgTable(
  "courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    // { questions: [...], answers: [...] } — populated after clarification step
    clarification: jsonb("clarification"),
    // { topic, scope_summary, tiers: [...] } — populated after framework step
    framework: jsonb("framework"),
    // { questions: [...], answers: [...], gradings: [...] } — populated after baseline step
    baseline: jsonb("baseline"),
    startingTier: integer("starting_tier"),
    currentTier: integer("current_tier").notNull().default(1),
    totalXp: integer("total_xp").notNull().default(0),
    status: text("status").notNull().default("scoping"),
    summary: text("summary"),
    summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Restrict status to known lifecycle values — DB-level guard against bad writes.
    check("courses_status_check", sql`${t.status} IN ('scoping','active','archived')`),
    // Tier values are 1-indexed (matches `framework.tiers` ordinals); zero/negative
    // values would break `progression.ts` math and `due-concepts` SM-2 reads.
    check("courses_current_tier_positive", sql`${t.currentTier} > 0`),
    // Pre-scoping rows have NULL `starting_tier`; once set it must follow the same
    // 1-indexed convention as `current_tier`.
    check(
      "courses_starting_tier_positive_or_null",
      sql`${t.startingTier} IS NULL OR ${t.startingTier} > 0`,
    ),
    // XP totals are monotonic (assessments only ever award positive XP); a
    // negative `total_xp` would indicate corruption or a buggy mutator.
    check("courses_total_xp_nonneg", sql`${t.totalXp} >= 0`),
    // Most queries filter by userId; index prevents seq-scans on large tables.
    index("courses_user_id_idx").on(t.userId),
  ],
);

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type Course = InferSelectModel<typeof courses>;

/**
 * Shape for INSERT statements. `userId` and `topic` are required (notNull,
 * no default). All other columns are optional: `id` defaults to a random UUID;
 * `currentTier`, `totalXp`, `status`, `createdAt`, `updatedAt` have defaults;
 * `clarification`, `framework`, `baseline`, `startingTier`, `summary`, and
 * `summaryUpdatedAt` are nullable.
 */
export type CourseInsert = InferInsertModel<typeof courses>;

/** Zod schema for validating insert payloads at trust boundaries (e.g. API input). */
export const coursesInsertSchema = createInsertSchema(courses);

/** Zod schema for validating rows read from the DB. */
export const coursesSelectSchema = createSelectSchema(courses);
