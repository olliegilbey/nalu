import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `user_profiles` — one row per learner (spec §3.1).
 *
 * `id` mirrors `auth.users(id)` (no FK). Production: the anonymous Supabase
 * user minted on the learner's first API request
 * (`src/server/requestUser.ts`); `ensureUserProfile` inserts the row.
 * Outside production: the seeded `DEV_USER_ID` row, claimed via the
 * `x-dev-user-id` header (`src/server/requestUser.ts`).
 *
 * No XP column: course XP lives on `courses.total_xp`. A lifetime total, if
 * a product surface needs one, sums `courses` per user (issue #154).
 */
export const userProfiles = pgTable("user_profiles", {
  id: uuid("id").primaryKey(),
  displayName: text("display_name").notNull(),
  // Optional — most users will leave this null. Carried into prompts when present.
  customInstructions: text("custom_instructions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
