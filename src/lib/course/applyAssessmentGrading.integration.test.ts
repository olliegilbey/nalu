import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { upsertConcept } from "@/db/queries/concepts";
import { openWave } from "@/db/queries/waves";
import { recordAssessment } from "@/db/queries/assessments";
import { WAVE } from "@/lib/config/tuning";
import { calculateMcXp, calculateXP } from "@/lib/scoring/xp";
import { applyAssessmentGrading } from "./applyAssessmentGrading";
import { eq } from "drizzle-orm";
import { assessments } from "@/db/schema";

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
 * grade it.
 */
async function seedAssessment(opts: {
  readonly assessmentKind: "card_mc" | "card_freetext";
  readonly conceptTier: number;
}): Promise<{ readonly assessmentId: string; readonly conceptId: string }> {
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
  // Seed in pre-grading state: isCorrect=false, quality=0, xp=0 are placeholders
  // that will be flipped by applyAssessmentGrading.
  const row = await recordAssessment({
    waveId: wave.id,
    conceptId: concept.id,
    turnIndex: 0,
    question: opts.assessmentKind === "card_mc" ? "Pick one" : "Explain it",
    userAnswer: "the answer",
    isCorrect: false,
    qualityScore: 0,
    assessmentKind: opts.assessmentKind,
    xpAwarded: 0,
  });
  return { assessmentId: row.id, conceptId: concept.id };
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

  it("free-text path: awards calculateXP(tier, qualityScore) and reflects verdict", async () => {
    await withTestDb(async () => {
      const { assessmentId } = await seedAssessment({
        assessmentKind: "card_freetext",
        conceptTier: 2,
      });

      const result = await applyAssessmentGrading({
        assessmentId,
        conceptTier: 2,
        signal: {
          kind: "free-text",
          questionId: "q3",
          verdict: "correct",
          qualityScore: 5,
        },
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

  it("free-text path (partial verdict): isCorrect=false despite non-zero quality", async () => {
    await withTestDb(async () => {
      const { assessmentId } = await seedAssessment({
        assessmentKind: "card_freetext",
        conceptTier: 1,
      });

      await applyAssessmentGrading({
        assessmentId,
        conceptTier: 1,
        signal: {
          kind: "free-text",
          questionId: "q4",
          verdict: "partial",
          qualityScore: 3,
        },
        tx: db,
      });

      const [row] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
      expect(row?.isCorrect).toBe(false);
      expect(row?.qualityScore).toBe(3);
    });
  });
});
