import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses } from "@/db/schema";
import { NotFoundError } from "./errors";
import {
  openScopingPass,
  getOpenScopingPassByCourse,
  closeScopingPass,
  ensureOpenScopingPass,
} from "./scopingPasses";

/** Fixed UUID for the test user. */
const USER = "33333333-3333-3333-3333-333333333333";

/**
 * Seed a user and a course row then return the course id.
 *
 * Each test calls `withTestDb` independently (truncates between runs), so we
 * seed inside a dedicated `withTestDb` call whose only job is row creation.
 * The query functions under test use the production `db` singleton which
 * points at the same testcontainer URL via `process.env.DATABASE_URL`.
 */
async function makeCourse(): Promise<string> {
  const courseId = "00000000-0000-0000-0000-000000000301";
  await withTestDb(async (db) => {
    await db.insert(userProfiles).values({ id: USER, displayName: "U" });
    await db.insert(courses).values({ id: courseId, userId: USER, topic: "x" });
  });
  return courseId;
}

describe("scopingPasses queries", () => {
  // -------------------------------------------------------------------------
  // Test 1: openScopingPass creates a row; getOpenScopingPassByCourse finds it
  // -------------------------------------------------------------------------
  it("openScopingPass + getOpenScopingPassByCourse round-trips", async () => {
    const courseId = await makeCourse();
    const pass = await openScopingPass(courseId);
    const fetched = await getOpenScopingPassByCourse(courseId);
    expect(fetched?.id).toBe(pass.id);
  });

  // -------------------------------------------------------------------------
  // Test 2: closeScopingPass flips status; open lookup returns null afterwards
  // -------------------------------------------------------------------------
  it("closeScopingPass flips status and clears the open lookup", async () => {
    const courseId = await makeCourse();
    const pass = await openScopingPass(courseId);
    await closeScopingPass(pass.id);
    expect(await getOpenScopingPassByCourse(courseId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 3: DB UNIQUE on course_id prevents a second insert
  // -------------------------------------------------------------------------
  it("UNIQUE(course_id) blocks a second open pass", async () => {
    const courseId = await makeCourse();
    await openScopingPass(courseId);
    await expect(openScopingPass(courseId)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Test 4: closeScopingPass is idempotent — closed_at sticks on second call
  // -------------------------------------------------------------------------
  it("closeScopingPass is idempotent (closed_at sticks across repeat calls)", async () => {
    const courseId = await makeCourse();
    const pass = await openScopingPass(courseId);

    const first = await closeScopingPass(pass.id);
    const second = await closeScopingPass(pass.id);

    // Both calls must return the same closed_at timestamp — COALESCE prevents
    // re-stamping. Status should be 'closed' on both returns.
    expect(first.closedAt).toEqual(second.closedAt);
    expect(first.status).toBe("closed");
    expect(second.status).toBe("closed");
  });

  // -------------------------------------------------------------------------
  // Test 5: closeScopingPass throws NotFoundError for unknown id
  // -------------------------------------------------------------------------
  it("closeScopingPass throws NotFoundError for unknown id", async () => {
    await withTestDb(async () => {
      await expect(closeScopingPass("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: ensureOpenScopingPass is idempotent — second call returns the same row
  // -------------------------------------------------------------------------
  it("ensureOpenScopingPass returns the existing open pass on second call", async () => {
    await withTestDb(async (db) => {
      const userId = "33333333-3333-3333-3333-333333333333";
      await db.insert(userProfiles).values({ id: userId, displayName: "u" });
      const [course] = await db.insert(courses).values({ userId, topic: "x" }).returning();
      const first = await ensureOpenScopingPass(course!.id);
      const second = await ensureOpenScopingPass(course!.id);
      expect(second.id).toBe(first.id);
      expect(second.status).toBe("open");
    });
  });

  // -------------------------------------------------------------------------
  // Test 7: ensureOpenScopingPass opens a fresh pass when none exists
  // -------------------------------------------------------------------------
  it("ensureOpenScopingPass opens a new pass when none exists", async () => {
    await withTestDb(async (db) => {
      const userId = "44444444-4444-4444-4444-444444444444";
      await db.insert(userProfiles).values({ id: userId, displayName: "u" });
      const [course] = await db.insert(courses).values({ userId, topic: "x" }).returning();
      const pass = await ensureOpenScopingPass(course!.id);
      expect(pass.courseId).toBe(course!.id);
      expect(pass.status).toBe("open");
    });
  });
});
