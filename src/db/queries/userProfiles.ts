import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { userProfiles, type UserProfile } from "@/db/schema";
// Import for internal throw sites; also re-exported so callers have one import site.
import { NotFoundError } from "./errors";

/**
 * `user_profiles` query surface (spec §8).
 *
 * Reads return Drizzle row types (no JSONB on this table — no extra
 * Zod refinement needed beyond the column types). Writes return the
 * affected row.
 *
 * `incrementUserXp` uses a SQL increment so concurrent assessment writes
 * compose correctly without read-modify-write races.
 */

// Re-export so callers only need one import site.
export { NotFoundError } from "./errors";

/** Fetch a user profile by primary key; throws `NotFoundError` if absent. */
export async function getUserById(id: string): Promise<UserProfile> {
  const [row] = await db.select().from(userProfiles).where(eq(userProfiles.id, id));
  if (!row) throw new NotFoundError("user_profile", id);
  return row;
}

/**
 * Insert a dev user row if it doesn't exist; return the row either way.
 *
 * `onConflictDoNothing` makes this safe to call repeatedly — the existing
 * row is preserved on PK collision. Useful for local seed and tests.
 */
export async function ensureDevUser(id: string, displayName = "Dev User"): Promise<UserProfile> {
  const [row] = await db
    .insert(userProfiles)
    .values({ id, displayName })
    .onConflictDoNothing({ target: userProfiles.id })
    .returning();
  // If the row already existed, `returning()` is empty — fall back to a read.
  if (row) return row;
  return getUserById(id);
}

/**
 * Atomically add `amount` XP to a user's running total.
 *
 * Using a SQL expression (`total_xp + amount`) rather than a read-modify-write
 * avoids lost-update races when multiple assessments complete concurrently.
 *
 * Raw SQL workaround: `db.update().set()` crashes `eslint-plugin-functional/
 * immutable-data` (requires typed-linting parserOptions, not configured).
 * `db.execute(sql\`...\`)` produces identical SQL and avoids the plugin issue.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function incrementUserXp(id: string, amount: number): Promise<void> {
  const result = await db.execute(
    sql`UPDATE user_profiles SET total_xp = total_xp + ${amount} WHERE id = ${id}`,
  );
  // postgres-js exposes affected-row count on `result.count` (not `rowCount`).
  if ((result as { count?: number | null }).count === 0) {
    throw new NotFoundError("user_profile", id);
  }
}
