import { describe, it, expect, vi, beforeEach } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import {
  assessments,
  concepts,
  contextMessages,
  courses,
  userProfiles,
  waveRatings,
  waves,
} from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { incrementCourseXpInTx, setCourseStartingStateInTx } from "@/db/queries/courses.tx";
import { upsertConcept } from "@/db/queries/concepts.writes";
import { appendMessage } from "@/db/queries/contextMessages.writes";
import { closeWave, openWave } from "@/db/queries/waves.writes";
import { WAVE } from "@/lib/config/tuning";
import { captureWaveRated } from "@/lib/analytics/captureWaveRated";
import { appRouter } from "./index";

/**
 * Integration tests for `wave.saveRating`: the learner rates a closed Wave.
 * Drives `appRouter.createCaller`, so each call runs `learnerProcedure` and
 * the input schema, then `saveWaveRating` against the testcontainer.
 *
 * The analytics module is mocked: its `after` call throws outside a Next
 * request scope, and `createCaller` has none. The mock also counts events.
 */
vi.mock("@/lib/analytics/captureWaveRated", () => ({ captureWaveRated: vi.fn() }));

const LEARNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEARNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["b"] },
  ],
} as const;

/** Open Wave `waveNumber` on a course, as the Wave openers do. */
async function openWaveNumber(courseId: string, waveNumber: number): Promise<string> {
  const wave = await openWave({
    courseId,
    waveNumber,
    tier: 1,
    frameworkSnapshot: FRAMEWORK,
    customInstructionsSnapshot: null,
    dueConceptsSnapshot: [],
    seedSource: {
      kind: "scoping_handoff",
      blueprint: { topic: "Ownership", outline: ["x"], openingText: "hi", plannedConcepts: [] },
    },
    turnBudget: WAVE.turnCount,
  });
  return wave.id;
}

/** Seed learner A's active course with Wave 1 open. */
async function seedCourse(): Promise<{ readonly courseId: string; readonly waveId: string }> {
  await db.insert(userProfiles).values({ id: LEARNER_A, displayName: "A" });
  const course = await createCourse({ userId: LEARNER_A, topic: "Rust" });
  await setCourseStartingStateInTx(course.id, { summary: "seed", startingTier: 1 }, db);
  const waveId = await openWaveNumber(course.id, 1);
  return { courseId: course.id, waveId };
}

/** Seed learner A's course with Wave 1 closed. */
async function seedClosedWave(): Promise<{ readonly courseId: string; readonly waveId: string }> {
  const seeded = await seedCourse();
  await closeWave(seeded.waveId, { summary: "done", blueprintEmitted: null });
  return seeded;
}

/** Every stored rating row. */
const ratingRows = () => db.select().from(waveRatings);

beforeEach(() => {
  vi.mocked(captureWaveRated).mockClear();
});

describe("wave.saveRating", () => {
  it("saves an overall rating for a closed Wave", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedClosedWave();
      const caller = appRouter.createCaller({ userId: LEARNER_A });

      const saved = await caller.wave.saveRating({ courseId, waveNumber: 1, overall: 4 });

      expect(saved).toEqual({ overall: 4, difficulty: null, pacing: null, usefulness: null });
      const rows = await ratingRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ waveId, overall: 4, difficulty: null, pacing: null });
      expect(rows[0]?.ratedAt).toBeInstanceOf(Date);
    });
  });

  it("a second save replaces the first and clears a dimension it omits", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedClosedWave();
      const caller = appRouter.createCaller({ userId: LEARNER_A });
      await caller.wave.saveRating({ courseId, waveNumber: 1, overall: 2, difficulty: 3 });
      const [first] = await ratingRows();

      const saved = await caller.wave.saveRating({ courseId, waveNumber: 1, overall: 5 });

      // The row holds the latest save whole; it never merges with the first.
      expect(saved).toEqual({ overall: 5, difficulty: null, pacing: null, usefulness: null });
      const rows = await ratingRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ overall: 5, difficulty: null });
      // `rated_at` moves to the latest save.
      expect(rows[0]!.ratedAt.getTime()).toBeGreaterThanOrEqual(first!.ratedAt.getTime());
    });
  });

  it("saves all four stars", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedClosedWave();
      const caller = appRouter.createCaller({ userId: LEARNER_A });

      const stars = { overall: 5, difficulty: 3, pacing: 4, usefulness: 1 };
      const saved = await caller.wave.saveRating({ courseId, waveNumber: 1, ...stars });

      expect(saved).toEqual(stars);
      expect((await ratingRows())[0]).toMatchObject(stars);
    });
  });

  it("refuses an open Wave with PRECONDITION_FAILED and writes no row", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourse();
      const caller = appRouter.createCaller({ userId: LEARNER_A });

      await expect(
        caller.wave.saveRating({ courseId, waveNumber: 1, overall: 4 }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(await ratingRows()).toHaveLength(0);
    });
  });

  it("refuses another learner's course with NOT_FOUND and writes no row", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedClosedWave();
      const learnerB = appRouter.createCaller({ userId: LEARNER_B });

      const refusal = learnerB.wave.saveRating({ courseId, waveNumber: 1, overall: 4 });

      // The same message as an unknown Wave: it never discloses A's course.
      await expect(refusal).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: `wave 1 not found for course ${courseId}`,
      });
      expect(await ratingRows()).toHaveLength(0);
    });
  });

  it("refuses an unknown Wave number with NOT_FOUND", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedClosedWave();
      const caller = appRouter.createCaller({ userId: LEARNER_A });

      await expect(
        caller.wave.saveRating({ courseId, waveNumber: 99, overall: 4 }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: `wave 99 not found for course ${courseId}`,
      });
      expect(await ratingRows()).toHaveLength(0);
    });
  });

  it("refuses a star outside 1-5 with BAD_REQUEST and writes no row", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedClosedWave();
      const caller = appRouter.createCaller({ userId: LEARNER_A });

      for (const stars of [{ overall: 0 }, { overall: 6 }, { overall: 4, difficulty: 2.5 }]) {
        await expect(
          caller.wave.saveRating({ courseId, waveNumber: 1, ...stars }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(await ratingRows()).toHaveLength(0);
    });
  });

  it("a save leaves course XP, concepts and Context rows unchanged", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourse();
      await incrementCourseXpInTx(courseId, 65, db);
      await upsertConcept({ courseId, name: "Ownership", tier: 1 });
      await appendMessage({
        parent: { kind: "wave", id: waveId },
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "<learner_reply>hi</learner_reply>",
      });
      await closeWave(waveId, { summary: "done", blueprintEmitted: null });
      // Every table a save must not touch, read whole.
      const snapshot = async () => ({
        courses: await db.select().from(courses),
        concepts: await db.select().from(concepts),
        context: await db.select().from(contextMessages),
        waves: await db.select().from(waves),
        assessments: await db.select().from(assessments),
      });
      const before = await snapshot();

      const caller = appRouter.createCaller({ userId: LEARNER_A });
      await caller.wave.saveRating({ courseId, waveNumber: 1, overall: 1 });

      expect(await snapshot()).toEqual(before);
      expect(before.courses[0]?.totalXp).toBe(65);
    });
  });

  it("sends one wave_rated event per save and none on a refusal", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedClosedWave();
      await openWaveNumber(courseId, 2);
      const learnerA = appRouter.createCaller({ userId: LEARNER_A });
      const learnerB = appRouter.createCaller({ userId: LEARNER_B });

      await learnerA.wave.saveRating({ courseId, waveNumber: 1, overall: 4 });
      await learnerA.wave.saveRating({ courseId, waveNumber: 1, overall: 3, pacing: 5 });

      const capture = vi.mocked(captureWaveRated);
      expect(capture).toHaveBeenCalledTimes(2);
      // The caller's id, the Wave number and the stars given. No course id.
      expect(capture).toHaveBeenNthCalledWith(1, {
        userId: LEARNER_A,
        waveNumber: 1,
        stars: { overall: 4 },
      });
      expect(capture).toHaveBeenNthCalledWith(2, {
        userId: LEARNER_A,
        waveNumber: 1,
        stars: { overall: 3, pacing: 5 },
      });

      // Each refusal: an open Wave, another learner, an unknown Wave, a bad star.
      // Thunks, so each call starts only when its rejection is awaited.
      const refusals = [
        () => learnerA.wave.saveRating({ courseId, waveNumber: 2, overall: 4 }),
        () => learnerB.wave.saveRating({ courseId, waveNumber: 1, overall: 4 }),
        () => learnerA.wave.saveRating({ courseId, waveNumber: 99, overall: 4 }),
        () => learnerA.wave.saveRating({ courseId, waveNumber: 1, overall: 9 }),
      ];
      for (const refuse of refusals) await expect(refuse()).rejects.toBeDefined();

      expect(capture).toHaveBeenCalledTimes(2);
    });
  });
});
