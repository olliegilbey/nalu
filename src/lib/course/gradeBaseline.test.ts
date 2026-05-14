import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies before importing SUT.
vi.mock("@/lib/turn/executeTurn", () => ({ executeTurn: vi.fn() }));
vi.mock("@/db/queries/courses", async () => {
  const actual =
    await vi.importActual<typeof import("@/db/queries/courses")>("@/db/queries/courses");
  return {
    ...actual,
    getCourseById: vi.fn(),
    updateCourseScopingState: vi.fn(),
  };
});
vi.mock("@/db/queries/scopingPasses", () => ({
  ensureOpenScopingPass: vi.fn(),
}));

import { gradeBaseline, type BaselineAnswer } from "./gradeBaseline";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { BASELINE, PROGRESSION } from "@/lib/config/tuning";
import type { Course } from "@/db/schema";
import type { BaselineJsonb } from "@/lib/types/jsonb";

// --- fixtures ---------------------------------------------------------------

const COURSE_ID = "c1";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const TOPIC = "Rust ownership";

/** Full AI SDK v5 LlmUsage shape. */
const MOCK_USAGE = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/** Build an MC question in the new JSONB shape (prompt, not question). */
function mcQ(id: string, tier: number, correct: "A" | "B" | "C" | "D" = "A") {
  return {
    id,
    type: "multiple_choice" as const,
    prompt: `q-${id}?`,
    options: { A: "a", B: "b", C: "c", D: "d" },
    correct,
    freetextRubric: `rubric-${id}`,
    conceptName: `concept-${id}`,
    tier,
  };
}

/** Build a free_text question in the new JSONB shape. */
function ftQ(id: string, tier: number) {
  return {
    id,
    type: "free_text" as const,
    prompt: `q-${id}?`,
    freetextRubric: `rubric-${id}`,
    conceptName: `concept-${id}`,
    tier,
  };
}

/** Build a minimal BaselineJsonb with the given questions. */
function storedBaseline(questions: ReturnType<typeof mcQ>[]): BaselineJsonb {
  return { userMessage: "Here is your baseline.", questions, responses: [], gradings: [] };
}

function scopingCourse(baseline: BaselineJsonb): Course {
  return {
    id: COURSE_ID,
    userId: USER_ID,
    topic: TOPIC,
    status: "scoping",
    clarification: { userMessage: "", questions: [], responses: [] },
    framework: { userMessage: "", tiers: [], estimatedStartingTier: 1, baselineScopeTiers: [1] },
    baseline,
  } as unknown as Course;
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(executeTurn).mockReset();
  vi.mocked(getCourseById).mockReset();
  vi.mocked(updateCourseScopingState).mockReset();
  vi.mocked(ensureOpenScopingPass).mockReset();
  vi.mocked(updateCourseScopingState).mockResolvedValue({} as never);
});

// ===========================================================================
// Mechanical MC path
// ===========================================================================

describe("gradeBaseline — mechanical MC path", () => {
  it("grades a correct MC click at BASELINE.mcCorrectQuality, no LLM call", async () => {
    const questions = [mcQ("b1", 1, "A")];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions)));

    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "A" }];
    const result = await gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers });

    expect(executeTurn).not.toHaveBeenCalled();
    expect(result.gradings).toHaveLength(1);
    expect(result.gradings[0]?.qualityScore).toBe(BASELINE.mcCorrectQuality);
    expect(result.gradings[0]?.verdict).toBe("correct");
    expect(result.usage.inputTokens).toBe(0);
  });

  it("grades an incorrect MC click at BASELINE.mcIncorrectQuality, verdict=incorrect", async () => {
    const questions = [mcQ("b1", 1, "A")];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions)));

    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "B" }];
    const result = await gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers });

    expect(executeTurn).not.toHaveBeenCalled();
    expect(result.gradings[0]?.qualityScore).toBe(BASELINE.mcIncorrectQuality);
    // mcIncorrectQuality=1 < passingQualityScore=3 → verdict must be incorrect.
    expect(result.gradings[0]?.verdict).toBe(
      BASELINE.mcIncorrectQuality >= PROGRESSION.passingQualityScore ? "correct" : "incorrect",
    );
    expect(result.gradings[0]?.verdict).toBe("incorrect");
  });

  it("propagates conceptName from the question", async () => {
    const questions = [mcQ("b1", 2, "C")];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions)));

    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "C" }];
    const result = await gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers });

    expect(result.gradings[0]?.conceptName).toBe("concept-b1");
  });
});

// ===========================================================================
// LLM path via executeTurn
// ===========================================================================

describe("gradeBaseline — LLM path", () => {
  it("routes a native free-text answer to executeTurn and returns gradings", async () => {
    const questions = [ftQ("b1", 1)];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions as never)));
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: {
        userMessage: "Good job.",
        gradings: [
          {
            questionId: "b1",
            conceptName: "concept-b1",
            verdict: "correct",
            qualityScore: 4,
            rationale: "ok",
          },
        ],
      },
      usage: MOCK_USAGE,
    });

    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "my answer", fromEscape: false },
    ];
    const result = await gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers });

    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(result.gradings[0]?.qualityScore).toBe(4);
    expect(result.gradings[0]?.verdict).toBe("correct");
    expect(result.gradings[0]?.rationale).toBe("ok");
    expect(result.usage).toEqual(MOCK_USAGE);
  });

  it("partitions a mixed batch: MC clicks mechanical, free-text goes to LLM", async () => {
    const questions = [mcQ("b1", 1, "A"), ftQ("b2", 1)];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions as never)));
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: {
        userMessage: "Done.",
        gradings: [
          {
            questionId: "b2",
            conceptName: "concept-b2",
            verdict: "partial",
            qualityScore: 2,
            rationale: "partial",
          },
        ],
      },
      usage: MOCK_USAGE,
    });

    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "mc", selected: "A" },
      { id: "b2", kind: "freetext", text: "some text", fromEscape: false },
    ];
    const result = await gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers });

    expect(executeTurn).toHaveBeenCalledTimes(1);
    // Merge preserves question-array order (b1, b2).
    expect(result.gradings.map((g) => g.questionId)).toEqual(["b1", "b2"]);
    expect(result.gradings[0]?.verdict).toBe("correct"); // mechanical MC
    expect(result.gradings[1]?.verdict).toBe("partial"); // LLM graded
  });
});

// ===========================================================================
// Idempotency
// ===========================================================================

describe("gradeBaseline — idempotency", () => {
  it("returns stored gradings without LLM call when gradings already exist", async () => {
    const existingGradings = [
      {
        questionId: "b1",
        conceptName: "c",
        conceptTier: 1,
        verdict: "correct" as const,
        qualityScore: 4 as const,
        rationale: "already graded",
      },
    ];
    const courseWithGradings = {
      id: COURSE_ID,
      userId: USER_ID,
      topic: TOPIC,
      status: "scoping",
      baseline: {
        userMessage: "Here is your baseline.",
        questions: [mcQ("b1", 1, "A")],
        responses: [],
        gradings: existingGradings,
      },
    } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(courseWithGradings);

    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "A" }];
    const result = await gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers });

    expect(executeTurn).not.toHaveBeenCalled();
    expect(result.gradings).toEqual(existingGradings);
    expect(result.usage.inputTokens).toBe(0);
  });
});

// ===========================================================================
// Input invariants
// ===========================================================================

describe("gradeBaseline — input invariants", () => {
  it("throws on an answer for an unknown question id", async () => {
    const questions = [mcQ("b1", 1, "A")];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions)));

    const answers: BaselineAnswer[] = [{ id: "b9", kind: "mc", selected: "A" }];
    await expect(gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers })).rejects.toThrow(
      /unknown question id/,
    );
  });

  it("throws on duplicate answers for the same question", async () => {
    const questions = [mcQ("b1", 1, "A")];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions)));

    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "mc", selected: "A" },
      { id: "b1", kind: "mc", selected: "B" },
    ];
    await expect(gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers })).rejects.toThrow(
      /duplicate answer/,
    );
  });

  it("throws when a question has no answer", async () => {
    const questions = [mcQ("b1", 1, "A"), mcQ("b2", 1, "A")];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions)));

    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "A" }];
    await expect(gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers })).rejects.toThrow(
      /no answer provided/,
    );
  });

  it("throws when an MC answer is submitted for a free_text question", async () => {
    const questions = [ftQ("b1", 1)];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions as never)));

    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "A" }];
    await expect(gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers })).rejects.toThrow(
      /mc answer submitted for free_text/,
    );
  });
});

// ===========================================================================
// LLM response invariants
// ===========================================================================

describe("gradeBaseline — LLM response invariants", () => {
  it("throws when the grader returns an evaluation for an unsubmitted questionId", async () => {
    const questions = [ftQ("b1", 1)];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions as never)));
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: {
        userMessage: "ok",
        gradings: [
          {
            questionId: "b9",
            conceptName: "c",
            verdict: "correct",
            qualityScore: 3,
            rationale: "r",
          },
        ],
      },
      usage: MOCK_USAGE,
    });

    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "x", fromEscape: false },
    ];
    await expect(gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers })).rejects.toThrow(
      /unsubmitted ids/,
    );
  });

  it("throws when the grader omits a submitted questionId", async () => {
    const questions = [ftQ("b1", 1), ftQ("b2", 1)];
    vi.mocked(getCourseById).mockResolvedValue(scopingCourse(storedBaseline(questions as never)));
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: {
        userMessage: "ok",
        gradings: [
          {
            questionId: "b1",
            conceptName: "c",
            verdict: "correct",
            qualityScore: 3,
            rationale: "r",
          },
        ],
      },
      usage: MOCK_USAGE,
    });

    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "x", fromEscape: false },
      { id: "b2", kind: "freetext", text: "y", fromEscape: false },
    ];
    await expect(gradeBaseline({ courseId: COURSE_ID, userId: USER_ID, answers })).rejects.toThrow(
      /omitted ids/,
    );
  });
});
