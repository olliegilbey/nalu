import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";

const ID = "11111111-1111-1111-1111-111111111111";

describe("userProfiles queries", () => {
  it("ensureUserProfile creates a row and is idempotent", async () => {
    await withTestDb(async (db) => {
      const { ensureUserProfile } = await import("./userProfiles");
      await ensureUserProfile(ID);
      // Second call must not throw or duplicate — first-write-wins.
      await ensureUserProfile(ID);
      const rows = await db.select().from(userProfiles).where(eq(userProfiles.id, ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.displayName).toBe("Learner");
    });
  });
});
