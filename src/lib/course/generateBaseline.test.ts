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

import { generateBaseline } from "./generateBaseline";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import type { Course } from "@/db/schema";
import type { FrameworkJsonb, BaselineJsonb } from "@/lib/types/jsonb";

// --- fixtures ---------------------------------------------------------------

const COURSE_ID = "c1";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const TOPIC = "Rust ownership";

/** Minimal valid FrameworkJsonb (camelCase — new wire shape). */
const FRAMEWORK_JSONB: FrameworkJsonb = {
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    {
      number: 1,
      name: "Foundations",
      description: "Core ownership concepts.",
      exampleConcepts: ["borrow checker", "lifetimes", "move semantics", "References"],
    },
    {
      number: 2,
      name: "Intermediate",
      description: "Trait-based abstractions.",
      exampleConcepts: ["traits", "generics", "closures", "iterators"],
    },
  ],
};

/** Minimal scoping-status course with framework populated, baseline null. */
const SCOPING_COURSE = {
  id: COURSE_ID,
  userId: USER_ID,
  topic: TOPIC,
  status: "scoping",
  clarification: {
    questions: [
      {
        id: "q1",
        type: "free_text" as const,
        prompt: "What is your goal?",
        freetextRubric: "r",
      },
    ],
    responses: [{ questionId: "q1", freetext: "Learn systems programming." }],
  },
  framework: FRAMEWORK_JSONB,
  baseline: null,
} as unknown as Course;

/** Full AI SDK v5 `LanguageModelUsage` shape. */
const MOCK_USAGE = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/**
 * Construct a minimal valid multiple-choice baseline question for use in
 * test fixtures. Uses new `prompt` field (was `question`).
 */
function mcQuestion(id: string, tier: number) {
  return {
    id,
    tier,
    conceptName: "c",
    type: "multiple_choice" as const,
    prompt: "q?",
    options: { A: "a", B: "b", C: "c", D: "d" },
    correct: "A" as const,
    freetextRubric: "rubric",
  };
}

/**
 * Minimal valid BaselineTurn returned by executeTurn.
 * Shape: `{ userMessage, questions: { questions: [...] } }`.
 * Needs >=7 questions (BASELINE.minQuestions).
 */
const VALID_BASELINE_PARSED = {
  userMessage: "Here is your baseline.",
  questions: {
    questions: [
      mcQuestion("b1", 1),
      mcQuestion("b2", 2),
      mcQuestion("b3", 1),
      mcQuestion("b4", 2),
      mcQuestion("b5", 1),
      mcQuestion("b6", 2),
      mcQuestion("b7", 1),
    ],
  },
};

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(executeTurn).mockReset();
  vi.mocked(getCourseById).mockReset();
  vi.mocked(updateCourseScopingState).mockReset();
  vi.mocked(ensureOpenScopingPass).mockReset();
});

describe("generateBaseline", () => {
  // Case 1: happy path — full flow from DB fetch through LLM call to persistence.
  it("happy path: fetches course, opens pass, calls executeTurn, persists BaselineJsonb, returns baseline", async () => {
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: VALID_BASELINE_PARSED,
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(SCOPING_COURSE);

    const result = await generateBaseline({ courseId: COURSE_ID, userId: USER_ID });

    // nextStage advances to answering
    expect(result.nextStage).toBe("answering");
    // Result is a BaselineTurn: { userMessage, questions: { questions: [...] } }
    expect(result.baseline.questions.questions).toHaveLength(7);

    // Persistence called with BaselineJsonb (responses and gradings initialised to []).
    expect(updateCourseScopingState).toHaveBeenCalledWith(
      COURSE_ID,
      expect.objectContaining({
        baseline: expect.objectContaining({
          questions: VALID_BASELINE_PARSED.questions.questions,
          responses: [],
          gradings: [],
        }),
      }),
    );

    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  // Case 2: idempotency — if baseline already stored, return it without calling LLM.
  it("idempotency: returns re-parsed baseline when already stored, does not call executeTurn", async () => {
    const storedBaseline: BaselineJsonb = {
      questions: VALID_BASELINE_PARSED.questions.questions,
      responses: [],
      gradings: [],
    };
    const courseWithBaseline = {
      ...SCOPING_COURSE,
      baseline: storedBaseline,
    } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(courseWithBaseline);

    const result = await generateBaseline({ courseId: COURSE_ID, userId: USER_ID });

    expect(result.nextStage).toBe("answering");
    // Reconstructed via makeBaselineSchema — question count must match stored.
    expect(result.baseline.questions.questions).toHaveLength(7);

    // Must NOT hit the LLM
    expect(executeTurn).not.toHaveBeenCalled();
  });

  // Case 3: status precondition — only valid during scoping phase.
  it("throws PRECONDITION_FAILED when course status is not 'scoping'", async () => {
    const activeCourse = { ...SCOPING_COURSE, status: "active" } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(activeCourse);

    await expect(generateBaseline({ courseId: COURSE_ID, userId: USER_ID })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  // Case 4: framework/clarification null precondition.
  it("throws PRECONDITION_FAILED when framework is null", async () => {
    const noFramework = { ...SCOPING_COURSE, framework: null } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(noFramework);

    await expect(generateBaseline({ courseId: COURSE_ID, userId: USER_ID })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("throws PRECONDITION_FAILED when clarification is null", async () => {
    const noClarification = { ...SCOPING_COURSE, clarification: null } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(noClarification);

    await expect(generateBaseline({ courseId: COURSE_ID, userId: USER_ID })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  // Case 5: scopeTiers wiring — executeTurn is called with responseSchema built from
  // framework.baselineScopeTiers (camelCase in new storage shape).
  it("scopeTiers wiring: executeTurn called with responseSchema derived from framework.baselineScopeTiers", async () => {
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p2" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: VALID_BASELINE_PARSED,
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(SCOPING_COURSE);

    await generateBaseline({ courseId: COURSE_ID, userId: USER_ID });

    // executeTurn should be called with a responseSchema (not a parser).
    const callArgs = vi.mocked(executeTurn).mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.responseSchema).toBeDefined();
    // No legacy parser field.
    expect((callArgs as unknown as Record<string, unknown>)?.parser).toBeUndefined();
  });
});
