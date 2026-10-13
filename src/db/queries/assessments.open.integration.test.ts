import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { namespaceQuestionId } from "@/lib/course/namespaceQuestionId";
import { getAssessmentsByWave, getAssessmentByWaveAndQuestionId } from "./assessments";
import { recordAssessment } from "./assessments.record";
import { insertOpenAssessments } from "./assessments.open";
import { WAVE, CONCEPT, CONCEPT_B, seedFixtures } from "./assessments.fixtures";

describe("assessments open", () => {
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

  it("namespaced question_ids let the same raw id coexist across questionnaires in a wave", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Two questionnaires (distinct emitting-message ids) both using raw `q1`.
      // `namespaceQuestionId` prefixes each with its questionnaire id, so the
      // stored values differ and the unique index is satisfied — this is the
      // bug_004 fix in `insertNewQuestionnaire`.
      const idA = namespaceQuestionId("11111111-1111-1111-1111-111111111111", "q1");
      const idB = namespaceQuestionId("22222222-2222-2222-2222-222222222222", "q1");
      expect(idA).not.toBe(idB);

      await insertOpenAssessments({
        waveId: WAVE,
        turnIndex: 3,
        rows: [
          {
            conceptId: CONCEPT,
            questionId: idA,
            question: "first q1",
            assessmentKind: "card_freetext",
          },
        ],
      });
      // Second questionnaire at a later turn — must NOT collide.
      await insertOpenAssessments({
        waveId: WAVE,
        turnIndex: 6,
        rows: [
          {
            conceptId: CONCEPT,
            questionId: idB,
            question: "second q1",
            assessmentKind: "card_freetext",
          },
        ],
      });

      const rows = await getAssessmentsByWave(WAVE);
      expect(rows).toHaveLength(2);
      // Each namespaced id resolves to exactly its own row.
      expect((await getAssessmentByWaveAndQuestionId(WAVE, idA))!.question).toBe("first q1");
      expect((await getAssessmentByWaveAndQuestionId(WAVE, idB))!.question).toBe("second q1");
    });
  });
});
