import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse, NotFoundError } from "@/db/queries/courses";
import { openWave } from "@/db/queries/waves";
import { WAVE } from "@/lib/config/tuning";
import { loadWaveContext } from "./loadWaveContext";

/**
 * Integration tests for `loadWaveContext`.
 *
 * Runs against the real Postgres testcontainer so FK checks + the ownership
 * guard exercise the same code paths as production. Each `withTestDb` call
 * truncates every table first.
 *
 * Coverage (post-rewrite — open-questionnaire reconstruction moved out):
 *   1. Happy path → returns `{ course, wave }` for a valid (user, course, wave).
 *   2. Course owned by a different user → `NotFoundError` (info-leak-safe).
 *   3. Cross-course wave id (wave belongs to a sibling course under the same
 *      owner) → TRPC FORBIDDEN.
 */

const USER_ID = "55555555-5555-5555-5555-555555555555";
const OTHER_USER_ID = "66666666-6666-6666-6666-666666666666";

const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["b"] },
  ],
} as const;

/**
 * Open a single Wave under a fresh course owned by USER_ID. Returns the ids
 * each test needs (course + wave). User is upserted only once per `withTestDb`.
 */
async function seedCourseWithOpenWave(): Promise<{
  readonly courseId: string;
  readonly waveId: string;
}> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  const wave = await openWave({
    courseId: course.id,
    waveNumber: 1,
    tier: 1,
    frameworkSnapshot: FRAMEWORK,
    customInstructionsSnapshot: null,
    dueConceptsSnapshot: [],
    seedSource: {
      kind: "scoping_handoff",
      blueprint: {
        topic: "Ownership basics",
        outline: ["x"],
        openingText: "hi",
        plannedConcepts: [],
      },
    },
    turnBudget: WAVE.turnCount,
  });
  return { courseId: course.id, waveId: wave.id };
}

describe("loadWaveContext (integration)", () => {
  // -------------------------------------------------------------------------
  // 1. Happy path. Seed a (user, course, wave) triple and verify the loader
  //    returns the matching course + wave rows. No questionnaire field on the
  //    result shape anymore — that concept moved to `findOpenQuestionnaire`
  //    over typed `waves.chat_log`.
  // -------------------------------------------------------------------------
  it("returns { course, wave } for a valid (user, course, wave) triple", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const result = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      expect(result.wave.id).toBe(waveId);
      expect(result.course.id).toBe(courseId);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Ownership check. A course owned by user A must NOT be loadable by
  //    user B. `getCourseById` throws `NotFoundError` (not `Forbidden`) for
  //    cross-user reads — that is the info-leak-safe response. We assert the
  //    raw class here because `loadWaveContext` does not translate it to a
  //    TRPC code (the router layer does that translation).
  // -------------------------------------------------------------------------
  it("throws NotFoundError when the course is owned by a different user", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Insert a second user that will attempt to access the first user's course.
      await db.insert(userProfiles).values({ id: OTHER_USER_ID, displayName: "Other" });
      await expect(
        loadWaveContext({ userId: OTHER_USER_ID, courseId, waveId }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Cross-course containment. The wave id is real and belongs to courseA;
  //    the caller passes courseB (same owner). FORBIDDEN here is a real
  //    condition — both ids exist, but the wave is not a child of the named
  //    course, so the request must be rejected at the containment boundary.
  // -------------------------------------------------------------------------
  it("throws FORBIDDEN when the wave id does not belong to the supplied courseId", async () => {
    await withTestDb(async () => {
      await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
      // Course A owns the wave; course B is passed in as the supposed parent.
      const courseA = await createCourse({ userId: USER_ID, topic: "Rust A" });
      const courseB = await createCourse({ userId: USER_ID, topic: "Rust B" });
      const waveA = await openWave({
        courseId: courseA.id,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: FRAMEWORK,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: [],
        seedSource: {
          kind: "scoping_handoff",
          blueprint: { topic: "x", outline: ["x"], openingText: "x", plannedConcepts: [] },
        },
        turnBudget: WAVE.turnCount,
      });
      await expect(
        loadWaveContext({ userId: USER_ID, courseId: courseB.id, waveId: waveA.id }),
      ).rejects.toMatchObject({
        // TRPCError carries the code on the instance itself.
        code: "FORBIDDEN",
      } satisfies Partial<TRPCError>);
    });
  });
});
