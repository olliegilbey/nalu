import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import {
  getAssessmentsByWave,
  getAssessmentsByConcept,
  getAssessmentsByWaveAndConcept,
  NotFoundError,
} from "./assessments";
import { recordAssessment } from "./assessments.record";
import { WAVE, CONCEPT, CONCEPT_B, seedFixtures } from "./assessments.fixtures";

describe("assessments record", () => {
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
  // Test 10: bug_004 — the partial unique index `assessments_wave_question_unique`
  // keys on `(wave_id, question_id)` only (NOT turn_index). Two rows in the same
  // wave sharing a `question_id` collide regardless of turn. This pins both the
  // collision (raw reuse) and the fix (namespacing makes ids distinct).
  // -------------------------------------------------------------------------
  it("rejects two rows in the same wave that share a raw question_id (cross-turn collision)", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Turn 3: a questionnaire emits `q1`.
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 3,
        question: "first q1",
        questionId: "q1",
        userAnswer: "A",
        isCorrect: true,
        qualityScore: 4,
        assessmentKind: "card_freetext",
        xpAwarded: 10,
      });

      // Turn 6: a DIFFERENT questionnaire restarts numbering and emits `q1`
      // again. Same `(wave_id, 'q1')` → the partial unique index rejects it.
      // This is the bug_004 failure mode — an uncaught 23505 that 500s the turn.
      await expect(
        recordAssessment({
          waveId: WAVE,
          conceptId: CONCEPT,
          turnIndex: 6,
          question: "second q1",
          questionId: "q1",
          userAnswer: "B",
          isCorrect: false,
          qualityScore: 1,
          assessmentKind: "card_freetext",
          xpAwarded: 0,
        }),
      ).rejects.toThrow();
    });
  });
});
