import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { NotFoundError } from "./errors";
import {
  createCourse,
  getCourseById,
  listCoursesByUser,
  updateCourseScopingState,
  setCourseStartingState,
  updateCourseSummary,
  updateCourseTier,
  incrementCourseXp,
  archiveCourse,
} from "./courses";

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
  // Test 2: listCoursesByUser returns most-recent first
  // -----------------------------------------------------------------------
  it("listCoursesByUser returns courses ordered most-recent first", async () => {
    await seedUserAndRun(async () => {
      const a = await createCourse({ userId: USER, topic: "Topic A" });
      // Small pause to ensure createdAt differs (Postgres timestamp resolution
      // is microseconds; a tight loop can produce equal timestamps).
      await new Promise((r) => setTimeout(r, 5));
      const b = await createCourse({ userId: USER, topic: "Topic B" });

      const list = await listCoursesByUser(USER);
      expect(list).toHaveLength(2);
      // Most recent (B) must come first.
      expect(list[0]?.id).toBe(b.id);
      expect(list[1]?.id).toBe(a.id);
    });
  });

  // -----------------------------------------------------------------------
  // Test 3: updateCourseScopingState writes JSONB and validates on read
  // -----------------------------------------------------------------------
  it("updateCourseScopingState persists JSONB framework and validates on read", async () => {
    await seedUserAndRun(async () => {
      const course = await createCourse({ userId: USER, topic: "TypeScript generics" });

      // Write a minimal valid framework payload.
      const frameworkPayload = {
        topic: "TypeScript generics",
        scope_summary: "Covers generic types and constraints",
        estimated_starting_tier: 2,
        baseline_scope_tiers: [1, 2],
        tiers: [
          {
            number: 1,
            name: "Basics",
            description: "Intro",
            example_concepts: ["T", "U"],
          },
          {
            number: 2,
            name: "Advanced",
            description: "Constraints",
            example_concepts: ["extends"],
          },
        ],
      };

      await updateCourseScopingState(course.id, { framework: frameworkPayload });

      // Re-fetch and confirm JSONB was validated and round-tripped.
      const fetched = await getCourseById(course.id);
      expect(fetched.framework).toMatchObject({ estimated_starting_tier: 2 });
    });
  });

  // -----------------------------------------------------------------------
  // Test 4: setCourseStartingState transitions status to active
  // -----------------------------------------------------------------------
  it("setCourseStartingState sets status='active' and correct tiers", async () => {
    await seedUserAndRun(async () => {
      const course = await createCourse({ userId: USER, topic: "SQL indexes" });

      const updated = await setCourseStartingState(course.id, {
        initialSummary: "Covers B-tree and hash indexes",
        startingTier: 2,
        currentTier: 2,
      });

      expect(updated.status).toBe("active");
      expect(updated.startingTier).toBe(2);
      expect(updated.currentTier).toBe(2);
      expect(updated.summary).toBe("Covers B-tree and hash indexes");
    });
  });

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

  // -----------------------------------------------------------------------
  // setCourseStartingState rejects courses not in 'scoping' status
  // -----------------------------------------------------------------------
  it("setCourseStartingState rejects courses not in 'scoping' status", async () => {
    await seedUserAndRun(async () => {
      const course = await createCourse({ userId: USER, topic: "Archived topic" });
      // Archive the course so its status is 'archived', not 'scoping'.
      await archiveCourse(course.id);
      await expect(
        setCourseStartingState(course.id, {
          initialSummary: "x",
          startingTier: 1,
          currentTier: 1,
        }),
      ).rejects.toThrow(/expected 'scoping'/);
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
            topic: "x",
            scope_summary: "y",
            estimated_starting_tier: 1,
            baseline_scope_tiers: [1],
            // `tiers` is required by frameworkJsonbSchema — omitting it must throw.
          },
        }),
      ).rejects.toThrow();

      // Confirm the framework column was NOT written (parse threw before UPDATE).
      const fetched = await getCourseById(course.id);
      expect(fetched.framework).toBeNull();
    });
  });
});
