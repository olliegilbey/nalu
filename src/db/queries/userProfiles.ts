import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { NotFoundError } from "./errors";

/**
 * `user_profiles` query surface (spec §8).
 *
 * No JSONB on this table, so no Zod row guard beyond the column types.
 */

/** Re-exported domain error for missing query targets — single import site for callers. */
export { NotFoundError } from "./errors";

/**
 * Insert a `user_profiles` row for an authenticated user if one does not
 * already exist.
 *
 * Called from `protectedProcedure` on every authenticated request. A visitor
 * who just signed in anonymously (see `src/server/requestUser.ts`) has an
 * `auth.users` row but no `user_profiles` row yet — and `courses.user_id`
 * references `user_profiles.id`. `onConflictDoNothing` makes repeated calls
 * cheap and race-safe: first write wins, later calls are no-ops.
 *
 * `displayName` is `NOT NULL`; anonymous users have no name, so it defaults
 * to `"Learner"`.
 */
export async function ensureUserProfile(userId: string): Promise<void> {
  await db
    .insert(userProfiles)
    .values({ id: userId, displayName: "Learner" })
    .onConflictDoNothing({ target: userProfiles.id });
}

/**
 * One learner's custom instructions, raw as stored. Null means none set.
 *
 * @throws {NotFoundError} when no `user_profiles` row has this id.
 */
export async function getUserCustomInstructions(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ customInstructions: userProfiles.customInstructions })
    .from(userProfiles)
    .where(eq(userProfiles.id, userId));
  if (!row) throw new NotFoundError("user_profile", userId);
  return row.customInstructions;
}

/**
 * Replace one learner's custom instructions; null clears them. Stores the
 * text raw: escaping happens once, at prompt render. Re-reads the row after
 * the write (house style), so it returns the value now stored.
 *
 * @throws {NotFoundError} when no `user_profiles` row has this id.
 */
export async function updateUserCustomInstructions({
  userId,
  customInstructions,
}: {
  readonly userId: string;
  readonly customInstructions: string | null;
}): Promise<string | null> {
  await db.execute(sql`
    UPDATE user_profiles
    SET custom_instructions = ${customInstructions}
    WHERE id = ${userId}
  `);
  return getUserCustomInstructions(userId);
}
