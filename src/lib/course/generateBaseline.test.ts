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
// Wrap parseBaselineResponse with vi.fn() while preserving the real implementation
// so Case 5 (scopeTiers wiring) can spy on calls without breaking parser logic.
vi.mock("./parsers", async () => {
  const actual = await vi.importActual<typeof import("./parsers")>("./parsers");
  return {
    ...actual,
    parseBaselineResponse: vi.fn(actual.parseBaselineResponse),
  };
});

import { generateBaseline } from "./generateBaseline";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { parseBaselineResponse } from "./parsers";
import { baselineSchema } from "@/lib/prompts/baseline";
import type { Course } from "@/db/schema";
import type { FrameworkJsonb, BaselineJsonb } from "@/lib/types/jsonb";
import type { BaselineAssessment } from "@/lib/prompts/baseline";

// --- fixtures ---------------------------------------------------------------

const COURSE_ID = "c1";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const TOPIC = "Rust ownership";

/** Minimal valid FrameworkJsonb (snake_case, as stored). */
const FRAMEWORK_JSONB: FrameworkJsonb = {
  topic: TOPIC,
  scope_summary: "Baseline covers tiers 1, 2.",
  estimated_starting_tier: 1,
  baseline_scope_tiers: [1, 2],
  tiers: [
    {
      number: 1,
      name: "Foundations",
      description: "Core ownership concepts.",
      example_concepts: ["borrow checker", "lifetimes", "move semantics", "References"],
    },
    {
      number: 2,
      name: "Intermediate",
      description: "Trait-based abstractions.",
      example_concepts: ["traits", "generics", "closures", "iterators"],
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
    questions: [{ id: "q1", text: "What is your goal?", type: "free_text" as const }],
    answers: [{ questionId: "q1", answer: "Learn systems programming." }],
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
 * test fixtures. Reusable across happy-path and idempotency cases.
 */
function mcQuestion(id: string, tier: number) {
  return {
    id,
    tier,
    conceptName: "c",
    type: "multiple_choice" as const,
    question: "q?",
    options: { A: "a", B: "b", C: "c", D: "d" },
    correct: "A" as const,
    freetextRubric: "rubric",
  };
}

/**
 * Minimal valid BaselineAssessment — needs >=7 questions (BASELINE.minQuestions).
 * Questions alternate between tiers 1 and 2 to stay within FRAMEWORK_JSONB.baseline_scope_tiers.
 */
const VALID_BASELINE: BaselineAssessment = {
  questions: [
    mcQuestion("b1", 1),
    mcQuestion("b2", 2),
    mcQuestion("b3", 1),
    mcQuestion("b4", 2),
    mcQuestion("b5", 1),
    mcQuestion("b6", 2),
    mcQuestion("b7", 1),
  ],
};

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(executeTurn).mockReset();
  vi.mocked(getCourseById).mockReset();
  vi.mocked(updateCourseScopingState).mockReset();
  vi.mocked(ensureOpenScopingPass).mockReset();
  // mockClear keeps the real implementation (set in vi.mock factory above);
  // only clears call history. This means Case 5 can spy without breaking parser logic.
  vi.mocked(parseBaselineResponse).mockClear();
});

describe("generateBaseline", () => {
  // Case 1: happy path — full flow from DB fetch through LLM call to persistence.
  it("happy path: fetches course, opens pass, calls executeTurn, persists BaselineJsonb, returns baseline", async () => {
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: { baseline: VALID_BASELINE, raw: "<baseline>{}</baseline>" },
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(SCOPING_COURSE);

    const result = await generateBaseline({ courseId: COURSE_ID, userId: USER_ID });

    // nextStage advances to answering
    expect(result.nextStage).toBe("answering");
    expect(result.baseline).toEqual(VALID_BASELINE);

    // Persistence called with BaselineJsonb (answers and gradings initialised to []).
    expect(updateCourseScopingState).toHaveBeenCalledWith(
      COURSE_ID,
      expect.objectContaining({
        baseline: expect.objectContaining({
          questions: VALID_BASELINE.questions,
          answers: [],
          gradings: [],
        }),
      }),
    );

    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  // Case 2: idempotency — if baseline already stored, return it without calling LLM.
  it("idempotency: returns re-parsed baseline when already stored, does not call executeTurn", async () => {
    // Need >=7 questions to pass baselineSchema.parse (BASELINE.minQuestions = 7).
    const storedBaseline: BaselineJsonb = {
      questions: [
        mcQuestion("b1", 1),
        mcQuestion("b2", 2),
        mcQuestion("b3", 1),
        mcQuestion("b4", 2),
        mcQuestion("b5", 1),
        mcQuestion("b6", 2),
        mcQuestion("b7", 1),
      ],
      answers: [],
      gradings: [],
    };
    const courseWithBaseline = {
      ...SCOPING_COURSE,
      baseline: storedBaseline,
    } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(courseWithBaseline);

    const result = await generateBaseline({ courseId: COURSE_ID, userId: USER_ID });

    expect(result.nextStage).toBe("answering");
    // Reconstructed via baselineSchema — questions must match stored shape.
    const expected = baselineSchema.parse({ questions: storedBaseline.questions });
    expect(result.baseline).toEqual(expected);

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

  // Case 5: scopeTiers wiring — parser passed to executeTurn delegates to
  // parseBaselineResponse with the scopeTiers from framework.baseline_scope_tiers.
  it("scopeTiers wiring: executeTurn parser delegates to parseBaselineResponse with framework.baseline_scope_tiers", async () => {
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p2" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: { baseline: VALID_BASELINE, raw: "<baseline>{}</baseline>" },
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(SCOPING_COURSE);

    await generateBaseline({ courseId: COURSE_ID, userId: USER_ID });

    // Extract the parser closure that was handed to executeTurn.
    const callArgs = vi.mocked(executeTurn).mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();

    // Invoke the parser with a valid raw string (>=7 questions per BASELINE.minQuestions).
    const rawResponse = `<baseline>${JSON.stringify({
      questions: [
        mcQuestion("b1", 1),
        mcQuestion("b2", 2),
        mcQuestion("b3", 1),
        mcQuestion("b4", 2),
        mcQuestion("b5", 1),
        mcQuestion("b6", 2),
        mcQuestion("b7", 1),
      ],
    })}</baseline>`;
    callArgs!.parser(rawResponse);

    // The closure must delegate to parseBaselineResponse with the correct scopeTiers.
    expect(parseBaselineResponse).toHaveBeenCalledWith(rawResponse, {
      scopeTiers: FRAMEWORK_JSONB.baseline_scope_tiers,
    });
  });
});
