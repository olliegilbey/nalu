import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { assessments } from "@/db/schema";
import { namespaceQuestionId } from "@/lib/course/namespaceQuestionId";
import { NotFoundError } from "./errors";
import { getAssessmentByWaveAndQuestionId } from "./assessments";
import { insertOpenAssessments } from "./assessments.open";
import { WAVE, CONCEPT, CONCEPT_B, seedFixtures } from "./assessments.fixtures";

describe("assessments open", () => {
  // -------------------------------------------------------------------------
  // Test 8: insertOpenAssessments — batch path under happy + guard conditions
  // Direct coverage for the mid-turn batch insert helper: one MAX/scope-check
  // per batch rather than per row.
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
      const rows = await db.select().from(assessments).where(eq(assessments.waveId, WAVE));
      expect(rows).toHaveLength(0);
    });
  });

  it("insertOpenAssessments rejects a turnIndex below the wave's current max", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Seed a turn-5 assessment so the wave's current MAX is 5.
      await insertOpenAssessments({
        waveId: WAVE,
        turnIndex: 5,
        rows: [
          { conceptId: CONCEPT, questionId: "q-seed", question: "seed", assessmentKind: "card_mc" },
        ],
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

  it("insertOpenAssessments accepts an equal and a strictly greater turnIndex", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Turn 3, then 5, then 5 again — all valid. Equal is allowed: a second
      // batch on the same turn. Each row needs a distinct question_id because
      // the partial unique index `assessments_wave_question_unique` forbids
      // dupes within a wave.
      for (const [turnIndex, questionId] of [
        [3, "q-asc-1"],
        [5, "q-asc-2"],
        [5, "q-asc-3"],
      ] as const) {
        await insertOpenAssessments({
          waveId: WAVE,
          turnIndex,
          rows: [{ conceptId: CONCEPT, questionId, question: "q?", assessmentKind: "card_mc" }],
        });
      }

      const rows = await db.select().from(assessments).where(eq(assessments.waveId, WAVE));
      expect(rows).toHaveLength(3);
    });
  });

  it("insertOpenAssessments throws NotFoundError for an unknown wave or concept", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);
      const unknownId = "00000000-0000-0000-0000-000000000000";
      const row = { questionId: "q-missing", question: "q?", assessmentKind: "card_mc" } as const;

      // Unknown wave: the wave lookup misses before any concept is checked.
      await expect(
        insertOpenAssessments({
          waveId: unknownId,
          turnIndex: 0,
          rows: [{ ...row, conceptId: CONCEPT }],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Known wave, unknown concept.
      await expect(
        insertOpenAssessments({
          waveId: WAVE,
          turnIndex: 0,
          rows: [{ ...row, conceptId: unknownId }],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
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

      const rows = await db.select().from(assessments).where(eq(assessments.waveId, WAVE));
      expect(rows).toHaveLength(2);
      // Each namespaced id resolves to exactly its own row.
      expect((await getAssessmentByWaveAndQuestionId(WAVE, idA))!.question).toBe("first q1");
      expect((await getAssessmentByWaveAndQuestionId(WAVE, idB))!.question).toBe("second q1");
    });
  });

  // -------------------------------------------------------------------------
  // Test 10: bug_004 — the partial unique index `assessments_wave_question_unique`
  // keys on `(wave_id, question_id)` only (NOT turn_index). Two rows in the same
  // wave sharing a `question_id` collide regardless of turn. This pins the
  // collision (raw reuse); the test above pins the fix (namespacing makes ids
  // distinct).
  // -------------------------------------------------------------------------
  it("rejects two rows in the same wave that share a raw question_id (cross-turn collision)", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Turn 3: a questionnaire emits `q1`.
      await insertOpenAssessments({
        waveId: WAVE,
        turnIndex: 3,
        rows: [
          {
            conceptId: CONCEPT,
            questionId: "q1",
            question: "first q1",
            assessmentKind: "card_freetext",
          },
        ],
      });

      // Turn 6: a DIFFERENT questionnaire restarts numbering and emits `q1`
      // again. Same `(wave_id, 'q1')` → the partial unique index rejects it.
      // This is the bug_004 failure mode — an uncaught 23505 that 500s the turn.
      await expect(
        insertOpenAssessments({
          waveId: WAVE,
          turnIndex: 6,
          rows: [
            {
              conceptId: CONCEPT,
              questionId: "q1",
              question: "second q1",
              assessmentKind: "card_freetext",
            },
          ],
        }),
      ).rejects.toThrow();
    });
  });
});
