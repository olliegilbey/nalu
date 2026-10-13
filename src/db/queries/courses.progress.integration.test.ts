import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { NotFoundError } from "./errors";
import { createCourse, getCourseById } from "./courses";
import {
  updateCourseSummary,
  updateCourseTier,
  incrementCourseXp,
  archiveCourse,
} from "./courses.progress";

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

describe("courses progress writes", () => {
  // -----------------------------------------------------------------------
  // Test 5: updateCourseSummary, updateCourseTier, incrementCourseXp,
  //         archiveCourse all persist correctly
  // -----------------------------------------------------------------------
  it("updateCourseSummary, updateCourseTier, incrementCourseXp, archiveCourse all persist", async () => {
    await seedUserAndRun(async () => {
      const course = await createCourse({ userId: USER, topic: "React hooks" });

      // updateCourseSummary
      await updateCourseSummary(course.id, "Hooks intro updated");
      const afterSummary = await getCourseById(course.id);
      expect(afterSummary.summary).toBe("Hooks intro updated");
      expect(afterSummary.summaryUpdatedAt).not.toBeNull();

      // updateCourseTier
      await updateCourseTier(course.id, 3);
      const afterTier = await getCourseById(course.id);
      expect(afterTier.currentTier).toBe(3);

      // incrementCourseXp — two calls → total should be 15
      await incrementCourseXp(course.id, 10);
      await incrementCourseXp(course.id, 5);
      const afterXp = await getCourseById(course.id);
      expect(afterXp.totalXp).toBe(15);

      // archiveCourse — no return value; verify by reading
      await archiveCourse(course.id);
      const afterArchive = await getCourseById(course.id);
      expect(afterArchive.status).toBe("archived");
    });
  });

  // -----------------------------------------------------------------------
  // archiveCourse throws NotFoundError on unknown id
  // -----------------------------------------------------------------------
  it("archiveCourse throws NotFoundError on unknown id", async () => {
    await withTestDb(async () => {
      await expect(archiveCourse("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // incrementCourseXp throws NotFoundError on unknown id
  // -----------------------------------------------------------------------
  it("incrementCourseXp throws NotFoundError on unknown id", async () => {
    await withTestDb(async () => {
      await expect(
        incrementCourseXp("00000000-0000-0000-0000-000000000000", 10),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // updateCourseTier throws NotFoundError on unknown id
  // -----------------------------------------------------------------------
  it("updateCourseTier throws NotFoundError on unknown id", async () => {
    await withTestDb(async () => {
      await expect(
        updateCourseTier("00000000-0000-0000-0000-000000000000", 2),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // updateCourseSummary throws NotFoundError on unknown id
  // -----------------------------------------------------------------------
  it("updateCourseSummary throws NotFoundError on unknown id", async () => {
    await withTestDb(async () => {
      await expect(
        updateCourseSummary("00000000-0000-0000-0000-000000000000", "ghost"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
