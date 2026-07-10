import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Concept, Assessment } from "@/db/schema";

// Query modules are mocked — these tests pin the tools' PROJECTION contract
// (compact, capped, name-keyed, XP-free), not the SQL underneath.
vi.mock("@/db/queries/concepts", () => ({
  getDueConceptsByCourse: vi.fn(),
  getConceptByNameForCourse: vi.fn(),
}));
vi.mock("@/db/queries/assessments", () => ({
  getAssessmentsByConcept: vi.fn(),
}));

import { getDueConceptsByCourse, getConceptByNameForCourse } from "@/db/queries/concepts";
import { getAssessmentsByConcept } from "@/db/queries/assessments";
import { AGENT_LOOKUP } from "@/lib/config/tuning";
import { buildWaveLookupTools } from "./waveLookupTools";

const COURSE_ID = "11111111-1111-4111-8111-111111111111";

function fakeConcept(overrides: Partial<Concept>): Concept {
  return {
    id: "c-id",
    courseId: COURSE_ID,
    name: "ownership",
    description: null,
    tier: 1,
    easinessFactor: 2.5,
    intervalDays: 1,
    repetitions: 1,
    nextReviewAt: new Date("2026-07-01T00:00:00Z"),
    lastQualityScore: 3,
    correctCount: 1,
    incorrectCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Concept;
}

function fakeAssessment(overrides: Partial<Assessment>): Assessment {
  return {
    id: "a-id",
    waveId: "w-id",
    conceptId: "c-id",
    turnIndex: 1,
    question: "q?",
    questionId: "q1",
    userAnswer: "answer",
    isCorrect: true,
    qualityScore: 4,
    assessmentKind: "multiple_choice",
    xpAwarded: 10,
    assessedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  } as Assessment;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildWaveLookupTools", () => {
  it("exposes exactly the two read-only lookups", () => {
    const tools = buildWaveLookupTools({ courseId: COURSE_ID });
    expect(Object.keys(tools).sort()).toEqual(["getConceptHistory", "getDueConcepts"]);
  });

  describe("getDueConcepts", () => {
    it("returns a name-keyed projection capped at the limit, soonest-due first", async () => {
      // 12 due concepts from the query; the tool must cap at AGENT_LOOKUP.dueConceptsLimit.
      const due = Array.from({ length: 12 }, (_v, i) =>
        fakeConcept({ id: `c${i}`, name: `concept-${i}`, tier: 1 + (i % 2) }),
      );
      vi.mocked(getDueConceptsByCourse).mockResolvedValue(due);
      const tools = buildWaveLookupTools({ courseId: COURSE_ID });

      const out = (await tools.getDueConcepts.execute!({}, {} as never)) as {
        dueConcepts: readonly { name: string; tier: number; lastQuality: number | null }[];
      };

      expect(out.dueConcepts).toHaveLength(AGENT_LOOKUP.dueConceptsLimit);
      // Query order (soonest-due first) is preserved by the cap.
      expect(out.dueConcepts[0]).toEqual({ name: "concept-0", tier: 1, lastQuality: 3 });
      // Projection carries NO ids, SM-2 internals, or XP.
      expect(Object.keys(out.dueConcepts[0]!).sort()).toEqual(["lastQuality", "name", "tier"]);
      // Scoped by the closure's courseId, never model input.
      expect(vi.mocked(getDueConceptsByCourse).mock.calls[0]![0]).toBe(COURSE_ID);
    });

    it("returns an empty list (not an error) when nothing is due", async () => {
      vi.mocked(getDueConceptsByCourse).mockResolvedValue([]);
      const tools = buildWaveLookupTools({ courseId: COURSE_ID });
      const out = await tools.getDueConcepts.execute!({}, {} as never);
      expect(out).toEqual({ dueConcepts: [] });
    });
  });

  describe("getConceptHistory", () => {
    it("returns capped attempts (most recent first) without XP or ids", async () => {
      vi.mocked(getConceptByNameForCourse).mockResolvedValue(fakeConcept({ id: "c-hist" }));
      const rows = Array.from({ length: 8 }, (_v, i) =>
        fakeAssessment({ id: `a${i}`, qualityScore: i % 6, isCorrect: i % 2 === 0 }),
      );
      vi.mocked(getAssessmentsByConcept).mockResolvedValue(rows);
      const tools = buildWaveLookupTools({ courseId: COURSE_ID });

      const out = (await tools.getConceptHistory.execute!(
        { conceptName: "ownership" },
        {} as never,
      )) as {
        conceptName: string;
        attempts: readonly { isCorrect: boolean; qualityScore: number }[];
      };

      expect(out.conceptName).toBe("ownership");
      expect(out.attempts).toHaveLength(AGENT_LOOKUP.historyAttemptsLimit);
      // XP and row ids must never reach the model (Core Design Principle).
      expect(Object.keys(out.attempts[0]!).sort()).toEqual(["isCorrect", "qualityScore"]);
      // Name resolution is scoped by the closure's courseId.
      expect(vi.mocked(getConceptByNameForCourse).mock.calls[0]!.slice(0, 2)).toEqual([
        COURSE_ID,
        "ownership",
      ]);
    });

    it("answers an unknown concept name with a model-readable notFound, not a throw", async () => {
      vi.mocked(getConceptByNameForCourse).mockResolvedValue(null);
      const tools = buildWaveLookupTools({ courseId: COURSE_ID });
      const out = await tools.getConceptHistory.execute!(
        { conceptName: "nonexistent" },
        {} as never,
      );
      // A throw would surface as a tool-error and burn a loop step on a
      // recoverable situation; a structured miss lets the model move on.
      expect(out).toEqual({ conceptName: "nonexistent", attempts: [], notFound: true });
      expect(vi.mocked(getAssessmentsByConcept)).not.toHaveBeenCalled();
    });
  });
});
