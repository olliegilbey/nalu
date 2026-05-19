import { describe, it, expect } from "vitest";
import { WAVE as WAVE_CONFIG } from "@/lib/config/tuning";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses, waves, concepts } from "@/db/schema";
import {
  recordAssessment,
  getAssessmentsByWave,
  getAssessmentsByConcept,
  getAssessmentsByWaveAndConcept,
  getAssessmentByWaveAndQuestionId,
  insertOpenAssessments,
  NotFoundError,
} from "./assessments";

/** Fixed UUIDs per plan §D9. */
const USER = "77777777-7777-7777-7777-777777777777";
const COURSE = "00000000-0000-0000-0000-000000000701";
const WAVE = "00000000-0000-0000-0000-000000000702";
const CONCEPT = "00000000-0000-0000-0000-000000000703";
/** A second course + its concept — used for cross-course pollution tests. */
const COURSE_B = "00000000-0000-0000-0000-000000000704";
const CONCEPT_B = "00000000-0000-0000-0000-000000000705";

/**
 * Minimal valid `frameworkSnapshot` — must satisfy `frameworkJsonbSchema`.
 * Matches the pattern established in contextMessages and concepts tests.
 */
const FRAMEWORK_SNAPSHOT = {
  topic: "x",
  scope_summary: "y",
  estimated_starting_tier: 1,
  baseline_scope_tiers: [1],
  tiers: [{ number: 1, name: "n", description: "d", example_concepts: ["e"] }],
} as const;

/**
 * Seed the full FK chain (userProfiles → courses → waves → concepts) into the
 * active test transaction. Must be called inside a `withTestDb` callback
 * because `withTestDb` truncates before each invocation.
 *
 * Optionally seeds a second course (COURSE_B) with one concept (CONCEPT_B) but
 * no wave — used for cross-course pollution tests.
 */
async function seedFixtures(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  { withCourseB = false }: { withCourseB?: boolean } = {},
): Promise<void> {
  await db.insert(userProfiles).values({ id: USER, displayName: "U" });
  await db.insert(courses).values({ id: COURSE, userId: USER, topic: "x" });
  await db.insert(waves).values({
    id: WAVE,
    courseId: COURSE,
    waveNumber: 1,
    tier: 1,
    frameworkSnapshot: FRAMEWORK_SNAPSHOT,
    customInstructionsSnapshot: null,
    dueConceptsSnapshot: [],
    seedSource: { kind: "scoping_handoff" },
    turnBudget: WAVE_CONFIG.turnCount,
  });
  await db.insert(concepts).values({ id: CONCEPT, courseId: COURSE, name: "x", tier: 1 });

  if (withCourseB) {
    // Second course owned by the same user; CONCEPT_B belongs to COURSE_B (not COURSE).
    // Used to verify that recording an assessment for WAVE (course A) with
    // CONCEPT_B (course B) throws a cross-course error.
    await db.insert(courses).values({ id: COURSE_B, userId: USER, topic: "y" });
    await db.insert(concepts).values({ id: CONCEPT_B, courseId: COURSE_B, name: "y", tier: 1 });
  }
}

describe("assessments queries", () => {
  // -------------------------------------------------------------------------
  // Test 1: recordAssessment round-trip through getAssessmentsByWave/ByConcept
  // -------------------------------------------------------------------------
  it("recordAssessment + getAssessmentsByWave/ByConcept round-trips a card_mc row", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Insert a card_mc assessment with a non-null question.
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 1,
        question: "q?",
        // question_id is required for card kinds (CHECK
        // `assessments_question_id_required_for_card_kinds`).
        questionId: "q-1",
        userAnswer: "B",
        isCorrect: true,
        qualityScore: 4,
        assessmentKind: "card_mc",
        xpAwarded: 20,
      });

      // Both getters should return exactly the inserted row.
      expect((await getAssessmentsByWave(WAVE)).length).toBe(1);
      expect((await getAssessmentsByConcept(CONCEPT)).length).toBe(1);

      // Cross-filter also returns it.
      expect((await getAssessmentsByWaveAndConcept(WAVE, CONCEPT)).length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: DB CHECK rejects card_mc with NULL question
  // The rejection is DB-level (assessments_question_required_for_card_kinds);
  // the TS type permits null in `question` (it's nullable), so the guard is
  // purely in the DB CHECK constraint.
  // -------------------------------------------------------------------------
  it("CHECK rejects card_mc with NULL question", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      await expect(
        recordAssessment({
          waveId: WAVE,
          conceptId: CONCEPT,
          turnIndex: 1,
          question: null,
          questionId: "q-null",
          userAnswer: "B",
          isCorrect: false,
          qualityScore: 1,
          assessmentKind: "card_mc",
          xpAwarded: 0,
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: DB CHECK accepts inferred with NULL question
  // `inferred` rows legitimately omit the question — the CHECK allows it.
  // -------------------------------------------------------------------------
  it("CHECK accepts inferred with NULL question", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Should not throw. `inferred` rows have no posed question; both
      // `question` and `question_id` are legitimately null.
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 2,
        question: null,
        questionId: null,
        userAnswer: "user prose that triggered the signal",
        isCorrect: true,
        qualityScore: 3,
        assessmentKind: "inferred",
        xpAwarded: 8,
      });

      expect((await getAssessmentsByWave(WAVE)).length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: cross-course guard — concept from a different course is rejected
  // (Codex P1 thread PRRT_kwDOR_akxs5-xHQM)
  // -------------------------------------------------------------------------
  it("recordAssessment rejects concept that belongs to a different course than the wave", async () => {
    await withTestDb(async (db) => {
      // Seed COURSE_B so CONCEPT_B exists in the DB but belongs to a different course.
      await seedFixtures(db, { withCourseB: true });

      // WAVE belongs to COURSE; CONCEPT_B belongs to COURSE_B — mismatch.
      await expect(
        recordAssessment({
          waveId: WAVE,
          conceptId: CONCEPT_B,
          turnIndex: 1,
          question: "q?",
          questionId: "q-x",
          userAnswer: "A",
          isCorrect: true,
          qualityScore: 4,
          assessmentKind: "card_mc",
          xpAwarded: 20,
        }),
      ).rejects.toThrow(/different courses/);
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: monotonic turn_index — out-of-order write is rejected
  // -------------------------------------------------------------------------
  it("recordAssessment rejects a turn_index lower than the current maximum", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // First assessment at turn 5 — succeeds.
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 5,
        question: "q?",
        questionId: "q-mono-1",
        userAnswer: "A",
        isCorrect: true,
        qualityScore: 4,
        assessmentKind: "card_mc",
        xpAwarded: 20,
      });

      // Second assessment at turn 3 (< 5) — must throw.
      await expect(
        recordAssessment({
          waveId: WAVE,
          conceptId: CONCEPT,
          turnIndex: 3,
          question: "q?",
          questionId: "q-mono-2",
          userAnswer: "B",
          isCorrect: false,
          qualityScore: 1,
          assessmentKind: "card_mc",
          xpAwarded: 0,
        }),
      ).rejects.toThrow(/turnIndex 3 < current max 5/);
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: monotonic turn_index — equal turn_index (same turn, two concepts)
  // and strictly ascending are both allowed
  // -------------------------------------------------------------------------
  it("recordAssessment accepts equal and strictly increasing turn_index", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Turn 3, then 5, then 5 again — all valid (equal is allowed).
      // Each row needs a distinct question_id because the partial unique index
      // `assessments_wave_question_unique` forbids dupes within a wave.
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 3,
        question: "q?",
        questionId: "q-asc-1",
        userAnswer: "A",
        isCorrect: true,
        qualityScore: 4,
        assessmentKind: "card_mc",
        xpAwarded: 20,
      });
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 5,
        question: "q?",
        questionId: "q-asc-2",
        userAnswer: "B",
        isCorrect: true,
        qualityScore: 4,
        assessmentKind: "card_mc",
        xpAwarded: 20,
      });
      // Same turn index as previous — multiple concepts assessed on turn 5.
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 5,
        question: "q2?",
        questionId: "q-asc-3",
        userAnswer: "C",
        isCorrect: false,
        qualityScore: 2,
        assessmentKind: "card_mc",
        xpAwarded: 5,
      });

      expect((await getAssessmentsByWave(WAVE)).length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Test 7: NotFoundError when wave or concept id does not exist
  // -------------------------------------------------------------------------
  it("recordAssessment throws NotFoundError for unknown wave or concept", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Unknown wave id — neither wave nor concept exists.
      await expect(
        recordAssessment({
          waveId: "00000000-0000-0000-0000-000000000000",
          conceptId: "00000000-0000-0000-0000-000000000000",
          turnIndex: 0,
          question: "q?",
          questionId: "q-missing",
          userAnswer: "A",
          isCorrect: true,
          qualityScore: 4,
          assessmentKind: "card_mc",
          xpAwarded: 0,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // Test 8: insertOpenAssessments — batch path under happy + guard conditions
  // Direct coverage for the mid-turn batch insert helper. recordAssessment
  // tests above exercise the equivalent guards on the single-row path, but
  // the batched code is structurally different (one MAX/scope-check per batch
  // rather than per row), so it gets its own scenarios.
  // -------------------------------------------------------------------------
  it("insertOpenAssessments rejects empty batches", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      await expect(insertOpenAssessments({ waveId: WAVE, turnIndex: 1, rows: [] })).rejects.toThrow(
        /rows must be non-empty/,
      );
    });
  });

  it("insertOpenAssessments rejects rows whose concept belongs to a different course", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db, { withCourseB: true });

      // Mixed batch: one valid row (CONCEPT in COURSE), one cross-course
      // (CONCEPT_B in COURSE_B). The batched scope check must reject the whole
      // batch — partial inserts would corrupt the wave.
      await expect(
        insertOpenAssessments({
          waveId: WAVE,
          turnIndex: 1,
          rows: [
            {
              conceptId: CONCEPT,
              questionId: "q-batch-1",
              question: "q?",
              assessmentKind: "card_mc",
            },
            {
              conceptId: CONCEPT_B,
              questionId: "q-batch-2",
              question: "q?",
              assessmentKind: "card_mc",
            },
          ],
        }),
      ).rejects.toThrow(/different courses/);

      // Verify no rows leaked in.
      const rows = await getAssessmentsByWave(WAVE);
      expect(rows).toHaveLength(0);
    });
  });

  it("insertOpenAssessments rejects a turnIndex below the wave's current max", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Seed a turn-5 assessment via the single-row path so the wave's
      // current MAX is 5.
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 5,
        question: "seed",
        questionId: "q-seed",
        userAnswer: "A",
        isCorrect: true,
        qualityScore: 4,
        assessmentKind: "card_mc",
        xpAwarded: 20,
      });

      await expect(
        insertOpenAssessments({
          waveId: WAVE,
          turnIndex: 3,
          rows: [
            {
              conceptId: CONCEPT,
              questionId: "q-back-1",
              question: "q?",
              assessmentKind: "card_mc",
            },
          ],
        }),
      ).rejects.toThrow(/turnIndex 3 < current max 5/);
    });
  });

  it("insertOpenAssessments happy path returns rows with placeholder grading fields", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      const inserted = await insertOpenAssessments({
        waveId: WAVE,
        turnIndex: 2,
        rows: [
          { conceptId: CONCEPT, questionId: "q-ok-mc", question: "q1?", assessmentKind: "card_mc" },
          {
            conceptId: CONCEPT,
            questionId: "q-ok-ft",
            question: "q2?",
            assessmentKind: "card_freetext",
          },
        ],
      });

      expect(inserted).toHaveLength(2);
      // Placeholder shape — exact values matter so updateAssessmentGrading can
      // distinguish "ungraded" rows.
      for (const row of inserted) {
        expect(row.userAnswer).toBe("");
        expect(row.isCorrect).toBe(false);
        expect(row.qualityScore).toBe(0);
        expect(row.xpAwarded).toBe(0);
        expect(row.turnIndex).toBe(2);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test 9: getAssessmentByWaveAndQuestionId — null-on-miss + lookup-on-hit
  // The mid-turn grader leans on the null return to skip stale signals
  // without confusing real DB errors for misses, so both branches need a test.
  // -------------------------------------------------------------------------
  it("getAssessmentByWaveAndQuestionId returns null when the (wave, questionId) pair has no row", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      const row = await getAssessmentByWaveAndQuestionId(WAVE, "q-does-not-exist");
      expect(row).toBeNull();
    });
  });

  it("getAssessmentByWaveAndQuestionId returns the row when the pair exists", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 1,
        question: "q?",
        questionId: "q-lookup",
        userAnswer: "B",
        isCorrect: true,
        qualityScore: 4,
        assessmentKind: "card_mc",
        xpAwarded: 20,
      });

      const row = await getAssessmentByWaveAndQuestionId(WAVE, "q-lookup");
      expect(row).not.toBeNull();
      expect(row!.questionId).toBe("q-lookup");
      expect(row!.waveId).toBe(WAVE);
    });
  });
});
