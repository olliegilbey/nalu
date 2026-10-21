import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { NotFoundError } from "./errors";

const ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
/** A course id no row has. */
const MISSING_COURSE_ID = "33333333-3333-3333-3333-333333333333";

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

  // Issue #236: the Wave openers snapshot this read. Two learners, so a join
  // on the wrong column would hand one learner's preference to another.
  it("getCourseOwnerCustomInstructionsInTx reads the course owner's text, and no one else's", async () => {
    await withTestDb(async (db) => {
      const { getCourseOwnerCustomInstructionsInTx, updateUserCustomInstructions } =
        await import("./userProfiles");
      const { createCourse } = await import("./courses");
      await db.insert(userProfiles).values([
        { id: ID, displayName: "A" },
        { id: OTHER_ID, displayName: "B" },
      ]);
      await updateUserCustomInstructions({ userId: ID, customInstructions: "A's <text> & more" });
      const courseA = await createCourse({ userId: ID, topic: "Rust" });
      const courseB = await createCourse({ userId: OTHER_ID, topic: "Go" });

      expect(await getCourseOwnerCustomInstructionsInTx(courseA.id, db)).toBe("A's <text> & more");
      expect(await getCourseOwnerCustomInstructionsInTx(courseB.id, db)).toBeNull();
      await expect(
        getCourseOwnerCustomInstructionsInTx(MISSING_COURSE_ID, db),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
