import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses } from "@/db/schema";
import { NotFoundError } from "./errors";
import { getWaveById, getLatestWaveNumberByCourse } from "./waves";

/** Fixed UUIDs — avoids runtime UUID generation. */
const USER_ID = "44444444-4444-4444-4444-444444444444";
const COURSE_ID = "00000000-0000-0000-0000-000000000401";

/**
 * Seed the test user and course, then run `fn` inside the same `withTestDb` call.
 * `withTestDb` truncates all tables before running, so this seed must happen
 * inside the same call to avoid FK failures.
 */
async function seedAndRun<T>(
  fn: (db: Parameters<Parameters<typeof withTestDb>[0]>[0]) => Promise<T>,
): Promise<T> {
  return withTestDb(async (db) => {
    // Insert the parent user_profile and course rows needed for FK constraints.
    await db.insert(userProfiles).values({ id: USER_ID, displayName: "Test User" });
    await db.insert(courses).values({ id: COURSE_ID, userId: USER_ID, topic: "Rust ownership" });
    return fn(db);
  });
}

describe("waves queries", () => {
  // -------------------------------------------------------------------------
  // Test 4: getLatestWaveNumberByCourse returns 0 when no waves exist
  // -------------------------------------------------------------------------
  it("getLatestWaveNumberByCourse returns 0 when no waves exist", async () => {
    await seedAndRun(async () => {
      const num = await getLatestWaveNumberByCourse(COURSE_ID);
      expect(num).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: getWaveById throws NotFoundError for unknown id
  // -------------------------------------------------------------------------
  it("getWaveById throws NotFoundError for unknown id", async () => {
    await withTestDb(async () => {
      await expect(getWaveById("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
