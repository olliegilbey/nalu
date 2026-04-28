import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
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
export const userProfiles = pgTable("user_profiles", {
  id: uuid("id").primaryKey(),
  displayName: text("display_name").notNull(),
  totalXp: integer("total_xp").notNull().default(0),
  customInstructions: text("custom_instructions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Full row returned from DB queries. */
export type UserProfile = InferSelectModel<typeof userProfiles>;

/** Shape for INSERT statements (id and createdAt are optional with defaults). */
export type UserProfileInsert = InferInsertModel<typeof userProfiles>;

/** Zod schema for validating insert payloads at trust boundaries (e.g. API input). */
export const userProfilesInsertSchema = createInsertSchema(userProfiles);

/** Zod schema for validating rows read from the DB. */
export const userProfilesSelectSchema = createSelectSchema(userProfiles);
