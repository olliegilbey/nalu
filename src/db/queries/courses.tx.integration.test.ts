import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { courses, userProfiles } from "@/db/schema";
import type { BaselineClosedJsonb } from "@/lib/types/jsonb";
import { createCourse, getCourseById } from "./courses";
import { updateCourseScopingState } from "./courses.scoping";
import {
  getCourseBaselineAndFrameworkInTx,
  setCourseBaselineInTx,
  setCourseStartingStateInTx,
  setCourseSummaryInTx,
  updateCourseTierInTx,
  incrementCourseXpInTx,
  lockCourseRowInTx,
} from "./courses.tx";
import { NotFoundError } from "./errors";

/** Fixed UUID for the test user — avoids generating UUIDs at runtime. */
const USER = "22222222-2222-2222-2222-222222222222";

/** Minimal valid framework matching `frameworkJsonbSchema`. */
const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1],
  tiers: [{ number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] }],
};

/** Minimal valid closed baseline: no questions, the close-turn fields set. */
const CLOSED_BASELINE: BaselineClosedJsonb = {
  userMessage: "closing",
  questions: [],
  responses: [],
  gradings: [],
  immutableSummary: "profile",
  summarySeed: "seed",
  startingTier: 2,
};

/** Seed the user and one scoping course, then run `fn` with the test db and course id. */
async function seedCourseAndRun(
  fn: (db: Parameters<Parameters<typeof withTestDb>[0]>[0], courseId: string) => Promise<void>,
): Promise<void> {
  return withTestDb(async (db) => {
    await db.insert(userProfiles).values({ id: USER, displayName: "U" });
    const course = await createCourse({ userId: USER, topic: "Rust" });
    await fn(db, course.id);
  });
}

describe("courses close-transaction queries", () => {
  it("getCourseBaselineAndFrameworkInTx returns the raw JSONB, or null for an unknown id", async () => {
    await seedCourseAndRun(async (db, courseId) => {
      await updateCourseScopingState(courseId, { framework: FRAMEWORK });
      await db.transaction(async (tx) => {
        expect(await getCourseBaselineAndFrameworkInTx(courseId, tx)).toEqual({
          baseline: null,
          framework: FRAMEWORK,
        });
        expect(
          await getCourseBaselineAndFrameworkInTx("00000000-0000-0000-0000-000000000000", tx),
        ).toBeNull();
      });
    });
  });

  it("writes the closed baseline, activates the course, then bumps tier and XP", async () => {
    await seedCourseAndRun(async (db, courseId) => {
      await db.transaction(async (tx) => {
        await setCourseBaselineInTx(courseId, CLOSED_BASELINE, tx);
        await setCourseStartingStateInTx(courseId, { summary: "seed", startingTier: 2 }, tx);
        await updateCourseTierInTx(courseId, 3, tx);
        await incrementCourseXpInTx(courseId, 10, tx);
        await incrementCourseXpInTx(courseId, 5, tx);
      });

      const after = await getCourseById(courseId);
      expect(after.baseline).toEqual(CLOSED_BASELINE);
      expect(after.status).toBe("active");
      expect(after.summary).toBe("seed");
      expect(after.startingTier).toBe(2);
      expect(after.currentTier).toBe(3);
      expect(after.totalXp).toBe(15);
    });
  });

  it("setCourseStartingStateInTx sets status='active', the summary, and both tiers", async () => {
    await seedCourseAndRun(async (db, courseId) => {
      // No transaction open: the helper runs on the `db` handle as-is.
      await setCourseStartingStateInTx(
        courseId,
        { summary: "Covers B-tree and hash indexes", startingTier: 2 },
        db,
      );

      const after = await getCourseById(courseId);
      expect(after.status).toBe("active");
      expect(after.startingTier).toBe(2);
      expect(after.currentTier).toBe(2);
      expect(after.summary).toBe("Covers B-tree and hash indexes");
    });
  });

  it("setCourseStartingStateInTx leaves a course that has left scoping untouched", async () => {
    await seedCourseAndRun(async (db, courseId) => {
      // No query helper archives a course; set the status directly.
      await db.update(courses).set({ status: "archived" }).where(eq(courses.id, courseId));
      await db.transaction(async (tx) => {
        await setCourseStartingStateInTx(courseId, { summary: "late", startingTier: 2 }, tx);
      });

      const after = await getCourseById(courseId);
      expect(after.status).toBe("archived");
      expect(after.startingTier).toBeNull();
      expect(after.summary).toBeNull();
    });
  });

  it("rolls back with the caller's transaction", async () => {
    await seedCourseAndRun(async (db, courseId) => {
      await expect(
        db.transaction(async (tx) => {
          await setCourseStartingStateInTx(courseId, { summary: "seed", startingTier: 2 }, tx);
          await incrementCourseXpInTx(courseId, 10, tx);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      const after = await getCourseById(courseId);
      expect(after.status).toBe("scoping");
      expect(after.totalXp).toBe(0);
    });
  });

  it("setCourseSummaryInTx overwrites the summary and stamps summary_updated_at", async () => {
    await seedCourseAndRun(async (db, courseId) => {
      await setCourseStartingStateInTx(courseId, { summary: "seed", startingTier: 1 }, db);
      // Backdate the stamp, so a strict `>` proves the helper re-stamps it.
      const oldStamp = new Date("2020-01-01T00:00:00Z");
      await db.update(courses).set({ summaryUpdatedAt: oldStamp }).where(eq(courses.id, courseId));
      await db.transaction(async (tx) => {
        await setCourseSummaryInTx(courseId, "rewritten after lesson 1", tx);
      });

      const after = await getCourseById(courseId);
      // Overwritten whole, never appended.
      expect(after.summary).toBe("rewritten after lesson 1");
      expect(after.summaryUpdatedAt!.getTime()).toBeGreaterThan(oldStamp.getTime());
    });
  });

  it("lockCourseRowInTx locks an existing course and throws NotFoundError for an unknown id", async () => {
    await seedCourseAndRun(async (db, courseId) => {
      await db.transaction(async (tx) => {
        await expect(lockCourseRowInTx(courseId, tx)).resolves.toBeUndefined();
        await expect(
          lockCourseRowInTx("00000000-0000-0000-0000-000000000000", tx),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });
  });
});
