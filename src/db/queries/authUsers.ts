import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { authUserActivitySchema, type AuthUserActivity } from "@/lib/types/authUserActivity";

/**
 * `auth.users` query surface for the orphan anonymous-user cleanup
 * (issue #55). Supabase Auth owns the `auth` schema, so it has no Drizzle
 * table here: a table in `src/db/schema/` would enter our migrations. Every
 * statement is raw SQL, and every row read is Zod-parsed.
 */

/**
 * Every auth user's activity facts: one row per `auth.users` row, with the
 * latest refresh and update times across their `auth.sessions`. The cleanup
 * runs the orphan rule over them.
 */
export async function listAuthUserActivity(tx: DbOrTx): Promise<readonly AuthUserActivity[]> {
  // `refreshed_at` has no time zone; Supabase writes it as UTC, so
  // `AT TIME ZONE 'UTC'` reads it back as the instant it names. Grouping by
  // the primary key lets the select name the other `u` columns.
  const rows = await tx.execute(sql`
    SELECT
      u.id,
      u.is_anonymous AS "isAnonymous",
      EXISTS (SELECT 1 FROM courses c WHERE c.user_id = u.id) AS "ownsCourse",
      u.created_at AS "createdAt",
      u.last_sign_in_at AS "lastSignInAt",
      MAX(s.refreshed_at) AT TIME ZONE 'UTC' AS "lastSessionRefreshedAt",
      MAX(s.updated_at) AS "lastSessionUpdatedAt"
    FROM auth.users u
    LEFT JOIN auth.sessions s ON s.user_id = u.id
    GROUP BY u.id
  `);
  return rows.map((row) => authUserActivitySchema.parse(row));
}

/**
 * Delete each user's `user_profiles` row, then their `auth.users` row,
 * inside the caller's tx. Returns the number of auth users deleted.
 *
 * `user_profiles.id` mirrors `auth.users.id` with no foreign key, so the
 * profile delete is explicit; it cascades to the user's courses. The auth
 * delete cascades, inside Supabase, to the user's sessions, refresh tokens
 * and identities.
 *
 * Each DELETE re-checks, in its own statement, that the user is anonymous
 * and owns no course. Under READ COMMITTED each statement sees courses
 * committed after the cleanup's read, so a learner who starts a course in
 * between keeps it. A bug in the orphan rule can never delete a named user
 * or a course owner either.
 */
export async function deleteUsersInTx(userIds: readonly string[], tx: DbOrTx): Promise<number> {
  // `IN ()` is a syntax error, and there is nothing to delete.
  if (userIds.length === 0) return 0;
  // Drizzle expands an array into `($1, $2, …)`, one param per id.
  await tx.execute(sql`
    DELETE FROM user_profiles p
    WHERE p.id IN ${userIds}
      AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.user_id = p.id)
      AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id AND u.is_anonymous)
  `);
  // `RETURNING id` counts the rows this DELETE removed.
  const deleted = await tx.execute(sql`
    DELETE FROM auth.users u
    WHERE u.id IN ${userIds}
      AND u.is_anonymous
      AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.user_id = u.id)
    RETURNING u.id
  `);
  return deleted.length;
}
