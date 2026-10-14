import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { assessments } from "@/db/schema";
import { getAssessmentsByConcept, getAssessmentByWaveAndQuestionId } from "./assessments";
import { insertOpenAssessments } from "./assessments.open";
import { WAVE, CONCEPT, seedFixtures } from "./assessments.fixtures";

describe("assessments queries", () => {
  // -------------------------------------------------------------------------
  // Test 1b: getAssessmentsByConcept `limit` caps in SQL, most recent first
  // (issue #62). Rows are inserted directly with explicit `assessedAt`:
  // inside the test transaction `now()` is constant, so defaults would tie.
  // -------------------------------------------------------------------------
  it("getAssessmentsByConcept applies limit after the most-recent-first order", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);
      // Inserted oldest first so insertion order cannot pass for the ORDER BY.
      await db.insert(assessments).values(
        [30, 20, 10].map((age, i) => ({
          waveId: WAVE,
          conceptId: CONCEPT,
          turnIndex: i + 1,
          question: `q${age}?`,
          questionId: `q-${age}`,
          userAnswer: "A",
          isCorrect: true,
          qualityScore: 4,
          assessmentKind: "card_mc",
          assessedAt: minutesAgo(age),
        })),
      );

      const capped = await getAssessmentsByConcept(CONCEPT, 2);
      expect(capped.map((r) => r.questionId)).toEqual(["q-10", "q-20"]);
      // No limit: the full history.
      expect(await getAssessmentsByConcept(CONCEPT)).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Test 1c: tied `assessedAt` breaks on `id` ASC. One quiz's rows share the
  // transaction's `now()`, so without a tiebreaker the order (and which rows
  // a `limit` keeps) is up to the planner.
  // -------------------------------------------------------------------------
  it("getAssessmentsByConcept orders tied assessedAt rows by id", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      const sameInstant = new Date(Date.now() - 60 * 1000);
      const ids = [
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
      ];
      // Inserted in DESCENDING id order, so heap order cannot pass for the
      // tiebreaker.
      await db.insert(assessments).values(
        ids.map((id, i) => ({
          id,
          waveId: WAVE,
          conceptId: CONCEPT,
          turnIndex: 1,
          question: `q${i}?`,
          questionId: `q-tie-${i}`,
          userAnswer: "A",
          isCorrect: true,
          qualityScore: 4,
          assessmentKind: "card_mc",
          assessedAt: sameInstant,
        })),
      );

      const ascendingIds = ids.toSorted();
      expect((await getAssessmentsByConcept(CONCEPT)).map((r) => r.id)).toEqual(ascendingIds);
      expect((await getAssessmentsByConcept(CONCEPT, 2)).map((r) => r.id)).toEqual(
        ascendingIds.slice(0, 2),
      );
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

      await insertOpenAssessments({
        waveId: WAVE,
        turnIndex: 1,
        rows: [
          { conceptId: CONCEPT, questionId: "q-lookup", question: "q?", assessmentKind: "card_mc" },
        ],
      });

      const row = await getAssessmentByWaveAndQuestionId(WAVE, "q-lookup");
      expect(row).not.toBeNull();
      expect(row!.questionId).toBe("q-lookup");
      expect(row!.waveId).toBe(WAVE);
    });
  });
});
