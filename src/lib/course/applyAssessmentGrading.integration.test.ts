import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { waitForLockWaiters } from "@/db/testing/waitForLockWaiters";
import { db, type DbOrTx } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { upsertConcept } from "@/db/queries/concepts.writes";
import { openWave } from "@/db/queries/waves.writes";
import { insertOpenAssessments } from "@/db/queries/assessments.open";
import { WAVE } from "@/lib/config/tuning";
import { calculateMcXp, calculateXP } from "@/lib/scoring/xp";
import { applyAssessmentGrading } from "./applyAssessmentGrading";
import { eq } from "drizzle-orm";
import { assessments, courses } from "@/db/schema";

/**
 * Integration tests for `applyAssessmentGrading`.
 *
 * Runs against the real Postgres testcontainer so the raw-SQL UPDATE,
 * camelCase re-fetch, and CHECK constraints all exercise the same paths as
 * production. Each `withTestDb` call truncates every table first.
 *
 * Pattern mirrors `submitBaseline.persist.integration.test.ts` — minimal
 * fixture: user → course → concept → open Wave → seed one in-Wave assessment
 * row in a "pre-grading" state (placeholder isCorrect/qualityScore/xpAwarded),
 * then call `applyAssessmentGrading` and assert the row + return shape.
 */

const USER_ID = "66666666-6666-6666-6666-666666666666";

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
 * Minimal scaffolding: seed a user + course + concept + open Wave and insert
 * a placeholder assessment row. Returns the assessment id so the test can
 * grade it, and the course id so it can read `courses.total_xp`.
 */
async function seedAssessment(opts: {
  readonly assessmentKind: "card_mc" | "card_freetext";
  readonly conceptTier: number;
}): Promise<{
  readonly assessmentId: string;
  readonly conceptId: string;
  readonly courseId: string;
}> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  const concept = await upsertConcept({
    courseId: course.id,
    name: "ownership",
    tier: opts.conceptTier,
  });
  const wave = await openWave({
    courseId: course.id,
    waveNumber: 1,
    tier: opts.conceptTier,
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
  // Seed in pre-grading state, as a questionnaire does: isCorrect=false,
  // quality=0, xp=0 are placeholders that applyAssessmentGrading flips.
  const [row] = await insertOpenAssessments({
    waveId: wave.id,
    turnIndex: 0,
    rows: [
      {
        conceptId: concept.id,
        questionId: "q1",
        question: opts.assessmentKind === "card_mc" ? "Pick one" : "Explain it",
        assessmentKind: opts.assessmentKind,
      },
    ],
  });
  if (!row) throw new Error("seedAssessment: insert returned no row");
  return { assessmentId: row.id, conceptId: concept.id, courseId: course.id };
}

/** Read `courses.total_xp` for one course. */
async function courseTotalXp(courseId: string): Promise<number> {
  const [row] = await db
    .select({ totalXp: courses.totalXp })
    .from(courses)
    .where(eq(courses.id, courseId));
  if (!row) throw new Error(`courseTotalXp: no course ${courseId}`);
  return row.totalXp;
}

describe("applyAssessmentGrading (integration)", () => {
  it("MC-index path: awards calculateMcXp(tier, correct) and stores q=4/isCorrect=true", async () => {
    await withTestDb(async () => {
      const { assessmentId } = await seedAssessment({
        assessmentKind: "card_mc",
        conceptTier: 2,
      });

      const result = await applyAssessmentGrading({
        assessmentId,
        conceptTier: 2,
        signal: { kind: "mc-index", questionId: "q1", correct: true },
        tx: db,
      });

      const expectedXp = calculateMcXp(2, true);
      expect(result).toEqual({ questionId: "q1", xpAwarded: expectedXp, kind: "mc-index" });

      const [row] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
      expect(row).toMatchObject({
        isCorrect: true,
        qualityScore: 4,
        xpAwarded: expectedXp,
      });
    });
  });

  it("MC-index path (incorrect): awards 0 XP and stores q=1/isCorrect=false", async () => {
    await withTestDb(async () => {
      const { assessmentId } = await seedAssessment({
        assessmentKind: "card_mc",
        conceptTier: 3,
      });

      const result = await applyAssessmentGrading({
        assessmentId,
        conceptTier: 3,
        signal: { kind: "mc-index", questionId: "q2", correct: false },
        tx: db,
      });

      expect(result.xpAwarded).toBe(0);
      const [row] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
      expect(row).toMatchObject({ isCorrect: false, qualityScore: 1, xpAwarded: 0 });
    });
  });

  it("free-text path: awards calculateXP(tier, qualityScore) and stores isCorrect", async () => {
    await withTestDb(async () => {
      const { assessmentId } = await seedAssessment({
        assessmentKind: "card_freetext",
        conceptTier: 2,
      });

      const result = await applyAssessmentGrading({
        assessmentId,
        conceptTier: 2,
        signal: { kind: "free-text", questionId: "q3", qualityScore: 5 },
        tx: db,
      });

      const expectedXp = calculateXP(2, 5);
      expect(result).toEqual({ questionId: "q3", xpAwarded: expectedXp, kind: "free-text" });
      const [row] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
      expect(row).toMatchObject({
        isCorrect: true,
        qualityScore: 5,
        xpAwarded: expectedXp,
      });
    });
  });

  it("free-text path (partial-band score): isCorrect=false despite non-zero quality", async () => {
    await withTestDb(async () => {
      const { assessmentId } = await seedAssessment({
        assessmentKind: "card_freetext",
        conceptTier: 1,
      });

      await applyAssessmentGrading({
        assessmentId,
        conceptTier: 1,
        signal: { kind: "free-text", questionId: "q4", qualityScore: 3 },
        tx: db,
      });

      const [row] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
      expect(row?.isCorrect).toBe(false);
      expect(row?.qualityScore).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #205: `courses.total_xp` caches the XP on the course's assessment
  // rows. Each grading adds the change it makes to its row, in the same tx.
  // ---------------------------------------------------------------------------
  it("adds the awarded XP to courses.total_xp", async () => {
    await withTestDb(async () => {
      const { assessmentId, courseId } = await seedAssessment({
        assessmentKind: "card_mc",
        conceptTier: 2,
      });

      const result = await applyAssessmentGrading({
        assessmentId,
        conceptTier: 2,
        signal: { kind: "mc-index", questionId: "q1", correct: true },
        tx: db,
      });

      // Sanity: a zero award would prove nothing about the bump.
      expect(result.xpAwarded).toBeGreaterThan(0);
      expect(await courseTotalXp(courseId)).toBe(result.xpAwarded);
    });
  });

  it("grading the same assessment twice adds its XP once", async () => {
    await withTestDb(async () => {
      const { assessmentId, courseId } = await seedAssessment({
        assessmentKind: "card_mc",
        conceptTier: 2,
      });
      // A second tab or a replay grades the same row with the same answer.
      const grade = () =>
        applyAssessmentGrading({
          assessmentId,
          conceptTier: 2,
          signal: { kind: "mc-index", questionId: "q1", correct: true },
          tx: db,
        });

      await grade();
      await grade();

      expect(await courseTotalXp(courseId)).toBe(calculateMcXp(2, true));
    });
  });

  it("two concurrent gradings of one row add its XP once (the row lock)", async () => {
    await withTestDb(async () => {
      const { assessmentId, courseId } = await seedAssessment({
        assessmentKind: "card_mc",
        conceptTier: 2,
      });
      const grade = (tx: DbOrTx) =>
        applyAssessmentGrading({
          assessmentId,
          conceptTier: 2,
          signal: { kind: "mc-index", questionId: "q1", correct: true },
          tx,
        });

      // Test-fixture slot: tab B's tx starts inside tab A's and ends after it.
      let tabB: Promise<unknown> | undefined;
      await db.transaction(async (txA) => {
        await grade(txA);
        // Tab B grades the same row on its own connection. Hold tab A open
        // until tab B waits on its row lock, so the two really overlap.
        tabB = db.transaction((txB) => grade(txB));
        await waitForLockWaiters(1);
      });
      await tabB;

      // Without the lock, tab B reads XP 0 before tab A commits and adds it again.
      expect(await courseTotalXp(courseId)).toBe(calculateMcXp(2, true));
    });
  });

  it("a re-grade moves the course total to the row's new XP, never the sum", async () => {
    await withTestDb(async () => {
      const { assessmentId, courseId } = await seedAssessment({
        assessmentKind: "card_freetext",
        conceptTier: 2,
      });
      const grade = (qualityScore: 3 | 5) =>
        applyAssessmentGrading({
          assessmentId,
          conceptTier: 2,
          signal: { kind: "free-text", questionId: "q1", qualityScore },
          tx: db,
        });
      // Sanity: the two grades must award different XP, else the test proves nothing.
      expect(calculateXP(2, 5)).not.toBe(calculateXP(2, 3));

      // The re-grade also flips correctness: score 5 is in the correct band,
      // score 3 is not. The row must follow each one.
      await grade(5);
      const [afterFirst] = await db
        .select()
        .from(assessments)
        .where(eq(assessments.id, assessmentId));
      expect(afterFirst?.isCorrect).toBe(true);

      await grade(3);

      // The total matches the XP the last grading left on the row.
      const [row] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
      expect(row?.isCorrect).toBe(false);
      expect(row?.xpAwarded).toBe(calculateXP(2, 3));
      expect(await courseTotalXp(courseId)).toBe(calculateXP(2, 3));
    });
  });
});
