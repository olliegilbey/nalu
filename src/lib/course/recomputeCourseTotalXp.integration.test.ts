import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { assessments, concepts, courses, userProfiles, waves } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { lockCourseRowInTx } from "@/db/queries/courses.tx";
import { getConceptsByCourse } from "@/db/queries/concepts";
import { insertOpenAssessments } from "@/db/queries/assessments.open";
import { BASELINE, WAVE } from "@/lib/config/tuning";
import { mergeAndComputeXp } from "@/lib/scoring/baselineMerge";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import { applyAssessmentGrading } from "./applyAssessmentGrading";
import { loadWaveContext } from "./loadWaveContext";
import { persistScopingClose } from "./submitBaseline.persist";
import { persistWaveClose } from "./persistWaveClose";
import {
  BASELINE_PRECLOSE,
  FRAMEWORK,
  PARSED,
  USER_ID,
  seedScopingCourseAndRun,
} from "./submitBaseline.fixtures";
import { recomputeCourseTotalXp } from "./recomputeCourseTotalXp";

/**
 * Integration tests for `recomputeCourseTotalXp`, the issue #208 repair.
 *
 * Real Postgres testcontainer. The undercount fixture seeds the source rows
 * directly; the last test drives the live XP writers instead, so the repair
 * stays pinned to them.
 */

/** A closed baseline at starting tier 2: q5 (30 XP) + an MC at q4 (20 XP). */
const CLOSED_BASELINE = {
  userMessage: "closing message",
  questions: [
    ...BASELINE_PRECLOSE.questions,
    {
      id: "b2",
      type: "multiple_choice" as const,
      prompt: "Which keyword moves a value?",
      options: { A: "let", B: "move", C: "ref", D: "copy" },
      correct: "B" as const,
      freetextRubric: "rubric",
      conceptName: "moves",
      tier: 2,
    },
  ],
  responses: [...BASELINE_PRECLOSE.responses, { questionId: "b2", choice: "B" as const }],
  gradings: [
    {
      questionId: "b1",
      conceptName: "ownership",
      conceptTier: 2,
      verdict: "correct" as const,
      qualityScore: 5,
      rationale: "good",
    },
    {
      questionId: "b2",
      conceptName: "moves",
      conceptTier: 2,
      verdict: "correct" as const,
      qualityScore: BASELINE.mcCorrectQuality,
      rationale: "Selected the correct option.",
    },
  ],
  immutableSummary: "durable profile",
  summarySeed: "evolving seed",
  startingTier: 2,
};

/** Baseline XP of {@link CLOSED_BASELINE}: 2×10×1.5 + 2×10×1. */
const CLOSED_BASELINE_XP = 50;

/** Insert one Wave row in the given status. Closed rows carry `closed_at`. */
async function insertWave(
  courseId: string,
  waveNumber: number,
  status: "open" | "closed",
): Promise<string> {
  const [row] = await db
    .insert(waves)
    .values({
      courseId,
      waveNumber,
      tier: 2,
      frameworkSnapshot: FRAMEWORK,
      customInstructionsSnapshot: null,
      dueConceptsSnapshot: [],
      seedSource: { kind: "scoping_handoff" },
      turnBudget: WAVE.turnCount,
      status,
      closedAt: status === "closed" ? new Date() : null,
    })
    .returning({ id: waves.id });
  if (!row) throw new Error("insertWave: insert returned no row");
  return row.id;
}

/** Insert graded assessment rows on one Wave, one per XP value. */
async function insertGradedRows(
  waveId: string,
  conceptId: string,
  xpValues: readonly number[],
): Promise<void> {
  await db.insert(assessments).values(
    xpValues.map((xpAwarded, i) => ({
      waveId,
      conceptId,
      turnIndex: 1,
      question: "Explain it",
      questionId: `qn:${i}`,
      userAnswer: "an answer",
      isCorrect: xpAwarded > 0,
      qualityScore: xpAwarded > 0 ? 4 : 1,
      assessmentKind: "card_freetext",
      xpAwarded,
    })),
  );
}

/**
 * Seed the #208 state: an active course whose total holds its baseline and
 * Wave completion XP, but misses the graded Wave XP. Waves 1 and 2 are
 * closed; Wave 3 is open, with one graded row. A second course holds rows
 * that must not count. Returns the undercounted course's id.
 */
async function seedUndercountedCourse(): Promise<string> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const [course] = await db
    .insert(courses)
    .values({
      userId: USER_ID,
      topic: "Rust",
      framework: FRAMEWORK,
      baseline: CLOSED_BASELINE,
      startingTier: 2,
      currentTier: 2,
      status: "active",
      // Baseline and completion XP only: the graded rows below are missing.
      totalXp: CLOSED_BASELINE_XP + 2 * WAVE.completionXp,
    })
    .returning({ id: courses.id });
  if (!course) throw new Error("seedUndercountedCourse: insert returned no row");
  const [concept] = await db
    .insert(concepts)
    .values({ courseId: course.id, name: "ownership", tier: 2 })
    .returning({ id: concepts.id });
  if (!concept) throw new Error("seedUndercountedCourse: concept insert returned no row");

  const wave1 = await insertWave(course.id, 1, "closed");
  await insertWave(course.id, 2, "closed");
  const wave3 = await insertWave(course.id, 3, "open");
  await insertGradedRows(wave1, concept.id, [20, 15, 0]);
  await insertGradedRows(wave3, concept.id, [10]);

  // A second course: its closed Wave and graded row belong to it alone.
  const [other] = await db
    .insert(courses)
    .values({ userId: USER_ID, topic: "Go", status: "active", totalXp: 0 })
    .returning({ id: courses.id });
  if (!other) throw new Error("seedUndercountedCourse: second course insert returned no row");
  const [otherConcept] = await db
    .insert(concepts)
    .values({ courseId: other.id, name: "goroutines", tier: 1 })
    .returning({ id: concepts.id });
  if (!otherConcept) throw new Error("seedUndercountedCourse: concept insert returned no row");
  const otherWave = await insertWave(other.id, 1, "closed");
  await insertGradedRows(otherWave, otherConcept.id, [999]);

  return course.id;
}

/** Read one course row whole, so a test can assert nothing on it moved. */
async function readCourseRow(courseId: string): Promise<typeof courses.$inferSelect> {
  const [row] = await db.select().from(courses).where(eq(courses.id, courseId));
  if (!row) throw new Error(`readCourseRow: no course ${courseId}`);
  return row;
}

/** A Wave close with no gradings and no SM-2 updates: only completion XP. */
const BARE_WAVE_CLOSE: WaveCloseTurn = {
  userMessage: "Closing chat.",
  summary: "We covered ownership.",
  gradings: [],
  nextUnitBlueprint: {
    topic: "Borrowing rules",
    outline: ["borrow"],
    openingText: "Welcome to lesson 2.",
    plannedConcepts: [{ name: "ownership", tier: 2, role: "fresh" }],
  },
  conceptUpdates: [],
};

describe("recomputeCourseTotalXp (integration)", () => {
  it("restores a course total that misses graded Wave XP", async () => {
    await withTestDb(async () => {
      const courseId = await seedUndercountedCourse();

      const result = await recomputeCourseTotalXp(courseId, { apply: true });

      // Baseline XP + 2 closed Waves + the course's graded rows (20+15+0+10).
      const expected = CLOSED_BASELINE_XP + 2 * WAVE.completionXp + 45;
      expect(result).toEqual({
        oldTotal: CLOSED_BASELINE_XP + 2 * WAVE.completionXp,
        newTotal: expected,
      });
      expect((await readCourseRow(courseId)).totalXp).toBe(expected);
    });
  });

  it("a second run changes nothing", async () => {
    await withTestDb(async () => {
      const courseId = await seedUndercountedCourse();
      const first = await recomputeCourseTotalXp(courseId, { apply: true });
      const rowAfterFirst = await readCourseRow(courseId);

      const second = await recomputeCourseTotalXp(courseId, { apply: true });

      expect(second).toEqual({ oldTotal: first.newTotal, newTotal: first.newTotal });
      // The whole row, `updated_at` included: an unchanged total is not written.
      expect(await readCourseRow(courseId)).toEqual(rowAfterFirst);
    });
  });

  it("a dry run reports the change and writes nothing", async () => {
    await withTestDb(async () => {
      const courseId = await seedUndercountedCourse();
      const rowBefore = await readCourseRow(courseId);

      const result = await recomputeCourseTotalXp(courseId, { apply: false });

      expect(result.newTotal).toBe(result.oldTotal + 45);
      expect(await readCourseRow(courseId)).toEqual(rowBefore);
    });
  });

  it("a course still in scoping recomputes to 0", async () => {
    // The fixture course holds an open baseline: questions, no gradings. A
    // second course has no baseline yet. Both carry a stale total, so the
    // test fails if the repair scores an open baseline or skips the write.
    await seedScopingCourseAndRun(async (openBaselineId) => {
      const noBaseline = await createCourse({ userId: USER_ID, topic: "Go" });
      // No WHERE: both courses are the only rows.
      await db.update(courses).set({ totalXp: 40 });

      const openResult = await recomputeCourseTotalXp(openBaselineId, { apply: true });
      const noBaselineResult = await recomputeCourseTotalXp(noBaseline.id, { apply: true });

      expect(openResult).toEqual({ oldTotal: 40, newTotal: 0 });
      expect(noBaselineResult).toEqual({ oldTotal: 40, newTotal: 0 });
      expect((await readCourseRow(openBaselineId)).totalXp).toBe(0);
      expect((await readCourseRow(noBaseline.id)).totalXp).toBe(0);
    });
  });

  it("agrees with the live writers", async () => {
    await seedScopingCourseAndRun(async (courseId, scopingPassId) => {
      // 1. Scoping close, with the XP `submitBaseline` computes: tier 2, q5.
      //    It passes the free-text gradings only, as `submitBaseline` does.
      const merged = mergeAndComputeXp({
        parsed: {
          gradings: PARSED.gradings.filter((g) => g.kind === "free-text"),
          startingTier: PARSED.startingTier,
        },
        mechanicalGradings: [],
        baselineQuestionIds: ["b1"],
        scopeTiers: FRAMEWORK.baselineScopeTiers,
      });
      const { wave1Id } = await persistScopingClose({
        courseId,
        scopingPassId,
        parsed: PARSED,
        merged,
      });

      // 2. A mid-turn grading: the mid-turn save's lock, then the grading.
      const [concept] = await getConceptsByCourse(courseId);
      if (!concept) throw new Error("expected the baseline concept");
      const [row] = await insertOpenAssessments({
        waveId: wave1Id,
        turnIndex: 1,
        rows: [
          {
            conceptId: concept.id,
            questionId: "qn:q1",
            question: "Explain ownership",
            assessmentKind: "card_freetext",
          },
        ],
      });
      if (!row) throw new Error("expected the placeholder row");
      await db.transaction(async (tx) => {
        await lockCourseRowInTx(courseId, tx);
        await applyAssessmentGrading({
          assessmentId: row.id,
          conceptTier: concept.tier,
          signal: { kind: "free-text", questionId: "q1", qualityScore: 5 },
          tx,
        });
      });

      // 3. Wave 1 closes: completion XP.
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId: wave1Id });
      await persistWaveClose({ ctx, parsed: BARE_WAVE_CLOSE, now: new Date() });

      const result = await recomputeCourseTotalXp(courseId, { apply: true });

      // Baseline 30 (tier 2, q5) + the grading's 30 (tier 2, q5) + one close.
      expect(result).toEqual({
        oldTotal: 60 + WAVE.completionXp,
        newTotal: 60 + WAVE.completionXp,
      });
    });
  });
});
