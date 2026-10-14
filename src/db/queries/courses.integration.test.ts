import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { NotFoundError } from "./errors";
import { createCourse, getCourseById } from "./courses";

/** Fixed UUID for the test user — avoids generating UUIDs at runtime. */
const USER = "22222222-2222-2222-2222-222222222222";

/**
 * Seed the test user before each test group that needs a FK parent row.
 * Each test uses `withTestDb` which truncates all tables, so we seed
 * inside each test's `withTestDb` call rather than in a separate beforeAll.
 */
async function seedUserAndRun<T>(
  fn: (db: Parameters<Parameters<typeof withTestDb>[0]>[0]) => Promise<T>,
): Promise<T> {
  return withTestDb(async (db) => {
    await db.insert(userProfiles).values({ id: USER, displayName: "U" });
    return fn(db);
  });
}

describe("courses queries", () => {
  // -----------------------------------------------------------------------
  // Test 1: createCourse + getCourseById round-trip
  // -----------------------------------------------------------------------
  it("createCourse + getCourseById round-trips topic and initial status", async () => {
    await seedUserAndRun(async () => {
      const course = await createCourse({ userId: USER, topic: "Rust ownership" });
      expect(course.id).toBeTruthy();
      expect(course.topic).toBe("Rust ownership");
      expect(course.status).toBe("scoping");

      // getCourseById must return the same row.
      const fetched = await getCourseById(course.id);
      expect(fetched.id).toBe(course.id);
      expect(fetched.topic).toBe("Rust ownership");
      expect(fetched.status).toBe("scoping");
    });
  });

  // -----------------------------------------------------------------------
  // getCourseById throws NotFoundError for missing id
  // -----------------------------------------------------------------------
  it("getCourseById throws NotFoundError for unknown id", async () => {
    await withTestDb(async () => {
      await expect(getCourseById("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // getCourseById with userId scopes ownership — wrong owner → NotFoundError
  // (info-leak-safe: indistinguishable from "id does not exist")
  // -----------------------------------------------------------------------
  it("getCourseById with a userId scopes ownership: wrong owner → NotFoundError", async () => {
    await withTestDb(async (db) => {
      const ownerId = "11111111-1111-1111-1111-111111111111";
      const intruderId = "22222222-2222-2222-2222-222222222222";
      await db.insert(userProfiles).values({ id: ownerId, displayName: "owner" });
      await db.insert(userProfiles).values({ id: intruderId, displayName: "intruder" });
      const course = await createCourse({ userId: ownerId, topic: "Rust" });

      await expect(getCourseById(course.id, intruderId)).rejects.toBeInstanceOf(NotFoundError);
      const ok = await getCourseById(course.id, ownerId);
      expect(ok.id).toBe(course.id);
      // Backward-compat: no userId → unscoped read still works.
      const legacy = await getCourseById(course.id);
      expect(legacy.id).toBe(course.id);
    });
  });
});
