import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses, waves, concepts } from "@/db/schema";
import {
  recordAssessment,
  getAssessmentsByWave,
  getAssessmentsByConcept,
  getAssessmentsByWaveAndConcept,
} from "./assessments";

/** Fixed UUIDs per plan §D9. */
const USER = "77777777-7777-7777-7777-777777777777";
const COURSE = "00000000-0000-0000-0000-000000000701";
const WAVE = "00000000-0000-0000-0000-000000000702";
const CONCEPT = "00000000-0000-0000-0000-000000000703";

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
 */
async function seedFixtures(db: Parameters<Parameters<typeof withTestDb>[0]>[0]): Promise<void> {
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
    turnBudget: 10,
  });
  await db.insert(concepts).values({ id: CONCEPT, courseId: COURSE, name: "x", tier: 1 });
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

      // Should not throw.
      await recordAssessment({
        waveId: WAVE,
        conceptId: CONCEPT,
        turnIndex: 2,
        question: null,
        userAnswer: "user prose that triggered the signal",
        isCorrect: true,
        qualityScore: 3,
        assessmentKind: "inferred",
        xpAwarded: 8,
      });

      expect((await getAssessmentsByWave(WAVE)).length).toBe(1);
    });
  });
});
