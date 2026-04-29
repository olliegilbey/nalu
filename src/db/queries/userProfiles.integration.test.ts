import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { NotFoundError } from "./errors";

const ID = "11111111-1111-1111-1111-111111111111";

describe("userProfiles queries", () => {
  it("ensureDevUser is idempotent", async () => {
    await withTestDb(async (db) => {
      const { ensureDevUser } = await import("./userProfiles");
      const first = await ensureDevUser(ID, "Dev User");
      const second = await ensureDevUser(ID, "Other");
      expect(first.id).toBe(ID);
      expect(first.displayName).toBe("Dev User");
      // Second call must not overwrite — first-write-wins via onConflictDoNothing.
      expect(second.displayName).toBe("Dev User");
      const rows = await db.select().from(userProfiles).where(eq(userProfiles.id, ID));
      expect(rows).toHaveLength(1);
    });
  });

  it("getUserById throws NotFoundError for missing id", async () => {
    await withTestDb(async () => {
      const { getUserById } = await import("./userProfiles");
      await expect(getUserById("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it("incrementUserXp adds to total_xp", async () => {
    await withTestDb(async (db) => {
      await db.insert(userProfiles).values({ id: ID, displayName: "Dev", totalXp: 10 });
      const { incrementUserXp } = await import("./userProfiles");
      await incrementUserXp(ID, 25);
      const [row] = await db.select().from(userProfiles).where(eq(userProfiles.id, ID));
      expect(row?.totalXp).toBe(35);
    });
  });
});
