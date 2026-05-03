import { pgTable, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

/**
 * `user_profiles` — one row per learner (spec §3.1).
 *
 * `id` mirrors `auth.users(id)` so the column shape is production-correct
 * from day one; until auth lands, the seed inserts a row at `DEV_USER_ID`.
 *
 * `total_xp` is a cached aggregate over `assessments.xp_awarded` (via
 * `courses.total_xp`). The query layer reconciles; we never trust this
 * column to drive logic.
 */
export const userProfiles = pgTable(
  "user_profiles",
  {
    id: uuid("id").primaryKey(),
    displayName: text("display_name").notNull(),
    totalXp: integer("total_xp").notNull().default(0),
    // Optional — most users will leave this null. Carried into prompts when present.
    customInstructions: text("custom_instructions"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // XP totals are monotonic (assessments only ever award positive XP); a negative
    // `total_xp` would indicate corruption or a buggy mutator. Mirrors the same
    // invariant on `courses.total_xp` (`courses_total_xp_nonneg`).
    check("user_profiles_total_xp_nonneg", sql`${t.totalXp} >= 0`),
  ],
);

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type UserProfile = InferSelectModel<typeof userProfiles>;

/**
 * Shape for INSERT statements. `createdAt` and `totalXp` are optional (both
 * have defaults); `id` is required — caller supplies the auth.users UUID.
 */
export type UserProfileInsert = InferInsertModel<typeof userProfiles>;

/** Zod schema for validating insert payloads at trust boundaries (e.g. API input). */
export const userProfilesInsertSchema = createInsertSchema(userProfiles);

/** Zod schema for validating rows read from the DB. */
export const userProfilesSelectSchema = createSelectSchema(userProfiles);
