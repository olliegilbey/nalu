import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { courses, userProfiles } from "@/db/schema";
import { withTestDb } from "@/db/testing/withTestDb";
import { deleteUsersInTx } from "@/db/queries/authUsers";
import { deleteOrphanAnonymousUsers } from "./deleteOrphanAnonymousUsers";

/**
 * Integration tests for `deleteOrphanAnonymousUsers`, the issue #55 cleanup.
 *
 * The testcontainer is plain Postgres, with no Supabase `auth` schema. So
 * this suite creates a minimal stub: only the columns the cleanup reads,
 * with Supabase's column types, and the sessions → users cascade.
 */

const DAY_MS = 86_400_000;

/** A time `days` days before now. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** Create the stub `auth` tables once, then empty them for this test. */
async function resetAuthStub(database: DB): Promise<void> {
  await database.execute(sql`CREATE SCHEMA IF NOT EXISTS auth`);
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY,
      is_anonymous boolean NOT NULL DEFAULT false,
      created_at timestamptz,
      last_sign_in_at timestamptz
    )
  `);
  // `refreshed_at` has no time zone in Supabase; GoTrue writes it as UTC.
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS auth.sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
      created_at timestamptz,
      updated_at timestamptz,
      refreshed_at timestamp without time zone
    )
  `);
  await database.execute(sql`TRUNCATE auth.users CASCADE`);
}

/** One stub auth user to seed, with optional profile, course and session. */
interface SeedUser {
  readonly isAnonymous: boolean;
  readonly createdDaysAgo: number;
  readonly lastSignInDaysAgo: number | null;
  readonly sessionRefreshedDaysAgo?: number;
  readonly hasProfile: boolean;
  readonly ownsCourse?: boolean;
}

/** Insert one stub auth user and the rows `seed` asks for; returns its id. */
async function seedUser(database: DB, seed: SeedUser): Promise<string> {
  const id = crypto.randomUUID();
  const lastSignInAt = seed.lastSignInDaysAgo === null ? null : daysAgo(seed.lastSignInDaysAgo);
  await database.execute(sql`
    INSERT INTO auth.users (id, is_anonymous, created_at, last_sign_in_at)
    VALUES (${id}, ${seed.isAnonymous}, ${daysAgo(seed.createdDaysAgo).toISOString()},
            ${lastSignInAt?.toISOString() ?? null})
  `);
  if (seed.sessionRefreshedDaysAgo !== undefined) {
    // A session created with the user; only its refresh time moves on.
    const created = daysAgo(seed.createdDaysAgo).toISOString();
    const refreshed = daysAgo(seed.sessionRefreshedDaysAgo).toISOString();
    await database.execute(sql`
      INSERT INTO auth.sessions (id, user_id, created_at, updated_at, refreshed_at)
      VALUES (${crypto.randomUUID()}, ${id}, ${created}, ${created},
              ${refreshed}::timestamptz AT TIME ZONE 'UTC')
    `);
  }
  if (seed.hasProfile) {
    await database.insert(userProfiles).values({ id, displayName: "Learner" });
  }
  if (seed.ownsCourse === true) {
    await database.insert(courses).values({ userId: id, topic: "Rust ownership" });
  }
  return id;
}

/** The ids of every row in a table with an `id` column, sorted. */
async function idsIn(database: DB, table: "auth.users" | "user_profiles"): Promise<string[]> {
  const rows = await database.execute<{ id: string }>(sql`SELECT id FROM ${sql.raw(table)}`);
  return rows.map((row) => row.id).sort();
}

describe("deleteOrphanAnonymousUsers", () => {
  it("deletes exactly the idle courseless anonymous users and their profiles", async () => {
    await withTestDb(async (database) => {
      await resetAuthStub(database);
      // Two orphans: one like most of production (no profile, no sign-in
      // time), and one with a profile and a long-stale session.
      const bareOrphan = await seedUser(database, {
        isAnonymous: true,
        createdDaysAgo: 90,
        lastSignInDaysAgo: null,
        hasProfile: false,
      });
      const profiledOrphan = await seedUser(database, {
        isAnonymous: true,
        createdDaysAgo: 60,
        lastSignInDaysAgo: 60,
        sessionRefreshedDaysAgo: 45,
        hasProfile: true,
      });
      // Four keepers, one per rule that keeps a user.
      const courseOwner = await seedUser(database, {
        isAnonymous: true,
        createdDaysAgo: 60,
        lastSignInDaysAgo: 60,
        hasProfile: true,
        ownsCourse: true,
      });
      const namedUser = await seedUser(database, {
        isAnonymous: false,
        createdDaysAgo: 60,
        lastSignInDaysAgo: 60,
        hasProfile: true,
      });
      const newcomer = await seedUser(database, {
        isAnonymous: true,
        createdDaysAgo: 5,
        lastSignInDaysAgo: 5,
        hasProfile: false,
      });
      const recentRefresh = await seedUser(database, {
        isAnonymous: true,
        createdDaysAgo: 60,
        lastSignInDaysAgo: 60,
        sessionRefreshedDaysAgo: 1,
        hasProfile: true,
      });
      const keepers = [courseOwner, namedUser, newcomer, recentRefresh].sort();

      // Dry run: counts the orphans, deletes nothing.
      const dryRun = await deleteOrphanAnonymousUsers({ apply: false }, database);
      expect(dryRun).toEqual({ scanned: 6, orphans: 2, deleted: 0 });
      expect(await idsIn(database, "auth.users")).toHaveLength(6);

      const applied = await deleteOrphanAnonymousUsers({ apply: true }, database);
      expect(applied).toEqual({ scanned: 6, orphans: 2, deleted: 2 });
      expect(await idsIn(database, "auth.users")).toEqual(keepers);
      expect(await idsIn(database, "user_profiles")).toEqual(
        [courseOwner, namedUser, recentRefresh].sort(),
      );
      expect(await idsIn(database, "user_profiles")).not.toContain(profiledOrphan);
      expect(await idsIn(database, "auth.users")).not.toContain(bareOrphan);
      // The auth delete cascaded to the orphan's session; the keeper's stays.
      const sessions = await database.execute<{ user_id: string }>(
        sql`SELECT user_id FROM auth.sessions`,
      );
      expect(sessions.map((row) => row.user_id)).toEqual([recentRefresh]);
      // The course owner keeps the course.
      expect(await database.select({ userId: courses.userId }).from(courses)).toEqual([
        { userId: courseOwner },
      ]);

      // A second apply finds nothing left to delete.
      const again = await deleteOrphanAnonymousUsers({ apply: true }, database);
      expect(again).toEqual({ scanned: 4, orphans: 0, deleted: 0 });
    });
  });

  it("never deletes a course owner or a named user, even when the id list names them", async () => {
    await withTestDb(async (database) => {
      await resetAuthStub(database);
      // A learner who starts a course between the read and the delete, and
      // a named account: both slip into the id list, as a race or a rule bug
      // would put them there.
      const lateCourseOwner = await seedUser(database, {
        isAnonymous: true,
        createdDaysAgo: 60,
        lastSignInDaysAgo: 60,
        hasProfile: true,
        ownsCourse: true,
      });
      const namedUser = await seedUser(database, {
        isAnonymous: false,
        createdDaysAgo: 60,
        lastSignInDaysAgo: 60,
        hasProfile: true,
      });
      const orphan = await seedUser(database, {
        isAnonymous: true,
        createdDaysAgo: 60,
        lastSignInDaysAgo: 60,
        hasProfile: true,
      });

      const deleted = await database.transaction((tx) =>
        deleteUsersInTx([lateCourseOwner, namedUser, orphan], tx),
      );

      // The DELETEs re-check the rule in SQL, so only the orphan goes.
      expect(deleted).toBe(1);
      expect(await idsIn(database, "auth.users")).toEqual([lateCourseOwner, namedUser].sort());
      expect(await idsIn(database, "user_profiles")).toEqual([lateCourseOwner, namedUser].sort());
      expect(await database.select({ userId: courses.userId }).from(courses)).toEqual([
        { userId: lateCourseOwner },
      ]);
    });
  });
});
