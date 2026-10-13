import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { CourseNotScopingError } from "./errors";
import { createCourse, getCourseById } from "./courses";
import { updateCourseScopingState } from "./courses.scoping";
import { setCourseStartingStateInTx } from "./courses.tx";

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

describe("courses scoping writes", () => {
  // -----------------------------------------------------------------------
  // Test 3: updateCourseScopingState writes JSONB and validates on read
  // -----------------------------------------------------------------------
  it("updateCourseScopingState persists JSONB framework and validates on read", async () => {
    await seedUserAndRun(async () => {
      const course = await createCourse({ userId: USER, topic: "TypeScript generics" });

      // Write a minimal valid framework payload (camelCase — spec §4.8).
      const frameworkPayload = {
        userMessage: "Here's the framework.",
        estimatedStartingTier: 2,
        baselineScopeTiers: [1, 2],
        tiers: [
          {
            number: 1,
            name: "Basics",
            description: "Intro",
            exampleConcepts: ["T", "U"],
          },
          {
            number: 2,
            name: "Advanced",
            description: "Constraints",
            exampleConcepts: ["extends"],
          },
        ],
      };

      await updateCourseScopingState(course.id, { framework: frameworkPayload });

      // Re-fetch and confirm JSONB was validated and round-tripped.
      const fetched = await getCourseById(course.id);
      expect(fetched.framework).toMatchObject({ estimatedStartingTier: 2 });
    });
  });

  // -----------------------------------------------------------------------
  // updateCourseScopingState rejects malformed JSONB (parse-before-persist)
  // -----------------------------------------------------------------------
  it("updateCourseScopingState throws ZodError for malformed framework payload", async () => {
    await seedUserAndRun(async () => {
      const course = await createCourse({ userId: USER, topic: "Invalid framework test" });

      // A framework payload missing the required `tiers` array must throw a
      // ZodError BEFORE the DB is touched (parse-before-persist boundary).
      await expect(
        updateCourseScopingState(course.id, {
          framework: {
            estimatedStartingTier: 1,
            baselineScopeTiers: [1],
            // `tiers` is required by frameworkJsonbSchema — omitting it must throw.
          },
        }),
      ).rejects.toThrow();

      // Confirm the framework column was NOT written (parse threw before UPDATE).
      const fetched = await getCourseById(course.id);
      expect(fetched.framework).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // updateCourseScopingState writes only while the course is in scoping
  // -----------------------------------------------------------------------
  it("updateCourseScopingState refuses a course that has left scoping and writes nothing", async () => {
    await seedUserAndRun(async (db) => {
      const course = await createCourse({ userId: USER, topic: "Closed course" });
      await setCourseStartingStateInTx(course.id, { summary: "s", startingTier: 1 }, db);

      const clarification = { userMessage: "late", questions: [], responses: [] };
      await expect(updateCourseScopingState(course.id, { clarification })).rejects.toBeInstanceOf(
        CourseNotScopingError,
      );
      expect((await getCourseById(course.id)).clarification).toBeNull();
    });
  });
});
