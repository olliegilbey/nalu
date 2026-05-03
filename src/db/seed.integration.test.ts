import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";

/**
 * Mirrors the seed's UPSERT shape rather than invoking `seed.ts` directly:
 * the script reads `DEV_USER_ID` from env at module load, which would tangle
 * the harness with real env. Re-running an `ON CONFLICT DO NOTHING` is the
 * invariant we care about — the SQL pattern is what we're locking in.
 */
const DEV_ID = "00000000-0000-0000-0000-000000000099";

describe("dev-user seed shape", () => {
  it("inserts then is a no-op on second run (ON CONFLICT DO NOTHING)", async () => {
    await withTestDb(async (db) => {
      // First insert — creates the row.
      await db
        .insert(userProfiles)
        .values({ id: DEV_ID, displayName: "Dev User" })
        .onConflictDoNothing({ target: userProfiles.id });

      // Second insert with a different display name — should be a no-op,
      // proving idempotence and confirming "first write wins" semantics so
      // dev edits to the seeded row aren't trampled on re-seed.
      await db
        .insert(userProfiles)
        .values({ id: DEV_ID, displayName: "Different Name" })
        .onConflictDoNothing({ target: userProfiles.id });

      const rows = await db.select().from(userProfiles).where(eq(userProfiles.id, DEV_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.displayName).toBe("Dev User");
    });
  });
});
