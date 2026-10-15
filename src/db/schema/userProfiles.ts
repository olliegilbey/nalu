import { pgTable, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * `user_profiles` — one row per learner (spec §3.1).
 *
 * `id` mirrors `auth.users(id)` (no FK). Production: the anonymous Supabase
 * user minted in `src/proxy.ts`; `ensureUserProfile` inserts the row.
 * Outside production: the seeded `DEV_USER_ID` row, claimed via the
 * `x-dev-user-id` header (`src/server/requestUser.ts`).
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
    // XP awards are never negative, so a negative `total_xp` would indicate
    // corruption or a buggy mutator. Mirrors `courses_total_xp_nonneg` on
    // `courses.total_xp`, which a re-grade can lower but not below zero.
    check("user_profiles_total_xp_nonneg", sql`${t.totalXp} >= 0`),
  ],
).enableRLS();
