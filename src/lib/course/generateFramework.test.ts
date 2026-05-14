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

import { generateFramework } from "./generateFramework";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { SCOPING } from "@/lib/config/tuning";
import type { Course } from "@/db/schema";
import type { FrameworkJsonb } from "@/lib/types/jsonb";

// --- fixtures ---------------------------------------------------------------

const COURSE_ID = "c1";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const TOPIC = "Rust ownership";

/** Minimal valid ClarificationJsonb — new camelCase/prompt shape. */
const CLARIFICATION = {
  userMessage: "Let me ask you a few questions.",
  questions: [
    {
      id: "q1",
      type: "free_text" as const,
      prompt: "What is your goal?",
      freetextRubric: "r",
    },
    {
      id: "q2",
      type: "free_text" as const,
      prompt: "Background?",
      freetextRubric: "r",
    },
  ],
  responses: [
    { questionId: "q1", freetext: "Build systems software." },
    { questionId: "q2", freetext: "C++ background." },
  ],
};

/**
 * Learner responses using new { questionId, freetext } shape.
 * (Replaces the old flat `answers: string[]`.)
 */
const RESPONSES: readonly { readonly questionId: string; readonly freetext: string }[] = [
  { questionId: "q1", freetext: "Build systems software." },
  { questionId: "q2", freetext: "C++ background." },
];

/** Scoping-status course with clarification populated (happy-path input). */
const SCOPING_COURSE = {
  id: COURSE_ID,
  userId: USER_ID,
  topic: TOPIC,
  status: "scoping",
  clarification: CLARIFICATION,
  framework: null,
} as unknown as Course;

/**
 * Minimal valid Framework (camelCase, as frameworkSchema emits).
 * One tier, estimatedStartingTier in tier set, baselineScopeTiers includes it.
 */
const PARSED_FRAMEWORK = {
  userMessage: "Here is the framework.",
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
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
};

/** Full AI SDK v5 `LanguageModelUsage` shape — sub-objects are required by the type. */
const MOCK_USAGE = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(executeTurn).mockReset();
  vi.mocked(getCourseById).mockReset();
  vi.mocked(updateCourseScopingState).mockReset();
  vi.mocked(ensureOpenScopingPass).mockReset();
});

describe("generateFramework", () => {
  it("happy path: fetches course, opens pass, calls executeTurn, persists FrameworkJsonb, returns it", async () => {
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: PARSED_FRAMEWORK,
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(SCOPING_COURSE);

    const result = await generateFramework({
      courseId: COURSE_ID,
      userId: USER_ID,
      responses: RESPONSES,
    });

    // nextStage advances to baseline
    expect(result.nextStage).toBe("baseline");
    // framework is returned as FrameworkJsonb (camelCase — new shape)
    expect(result.framework.estimatedStartingTier).toBe(1);
    expect(result.framework.tiers[0]?.exampleConcepts).toBeDefined();
    // persistence called with the jsonb shape
    expect(updateCourseScopingState).toHaveBeenCalledWith(
      COURSE_ID,
      expect.objectContaining({
        framework: expect.objectContaining({ estimatedStartingTier: 1 }),
      }),
    );
    // executeTurn was called once
    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  it("idempotency: returns cached FrameworkJsonb when framework already populated", async () => {
    const storedFramework: FrameworkJsonb = {
      userMessage: "Cached framework framing.",
      estimatedStartingTier: 1,
      baselineScopeTiers: [1, 2],
      tiers: [
        {
          number: 1,
          name: "Foundations",
          description: "desc",
          exampleConcepts: ["x"],
        },
      ],
    };
    const courseWithFramework = {
      ...SCOPING_COURSE,
      framework: storedFramework,
    } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(courseWithFramework);

    const result = await generateFramework({
      courseId: COURSE_ID,
      userId: USER_ID,
      responses: RESPONSES,
    });

    expect(result.framework).toEqual(storedFramework);
    expect(result.nextStage).toBe("baseline");
    // Must NOT hit the LLM
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("throws PRECONDITION_FAILED when course status is not 'scoping'", async () => {
    const activeCourse = { ...SCOPING_COURSE, status: "active" } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(activeCourse);

    await expect(
      generateFramework({ courseId: COURSE_ID, userId: USER_ID, responses: RESPONSES }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("throws PRECONDITION_FAILED when clarification is null", async () => {
    const noClarification = { ...SCOPING_COURSE, clarification: null } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(noClarification);

    await expect(
      generateFramework({ courseId: COURSE_ID, userId: USER_ID, responses: RESPONSES }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  // Case 5: responses are rendered as Q/A pairs in the envelope.
  it("userMessageContent contains Q/A pairs from stored questions and supplied responses", async () => {
    const xssCourse = {
      ...SCOPING_COURSE,
      clarification: {
        userMessage: "Let me ask you a few questions.",
        questions: [
          {
            id: "q1",
            type: "free_text" as const,
            prompt: "Goal?",
            freetextRubric: "r",
          },
          {
            id: "q2",
            type: "free_text" as const,
            prompt: "Background?",
            freetextRubric: "r",
          },
        ],
        // stored responses are empty — generateFramework uses params.responses
        responses: [],
      },
    } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(xssCourse);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p2" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: PARSED_FRAMEWORK,
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(xssCourse);

    await generateFramework({
      courseId: COURSE_ID,
      userId: USER_ID,
      responses: [
        { questionId: "q1", freetext: "learn Rust" },
        { questionId: "q2", freetext: "ok" },
      ],
    });

    const callArgs = vi.mocked(executeTurn).mock.calls[0]?.[0];
    // The envelope wraps the Q/A pairs.
    expect(callArgs?.userMessageContent).toContain("Q: Goal?");
    expect(callArgs?.userMessageContent).toContain("A: learn Rust");
  });

  // Case 6: empty responses array throws BAD_REQUEST immediately (before DB).
  it("throws BAD_REQUEST when responses is empty", async () => {
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);

    await expect(
      generateFramework({ courseId: COURSE_ID, userId: USER_ID, responses: [] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "responses cannot be empty" });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  // Case 7: too many responses throws BAD_REQUEST.
  it("throws BAD_REQUEST when responses exceed maxClarifyAnswers", async () => {
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);
    const tooMany = Array.from({ length: SCOPING.maxClarifyAnswers + 1 }, (_, i) => ({
      questionId: `q${i}`,
      freetext: `a${i}`,
    }));

    await expect(
      generateFramework({ courseId: COURSE_ID, userId: USER_ID, responses: tooMany }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  // Case 8: responses length doesn't match questions length — strict mismatch guard.
  it("throws BAD_REQUEST when responses.length does not match questions.length", async () => {
    // SCOPING_COURSE has 2 questions; supply only 1 response.
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);

    await expect(
      generateFramework({
        courseId: COURSE_ID,
        userId: USER_ID,
        responses: [{ questionId: "q1", freetext: "only one" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(executeTurn).not.toHaveBeenCalled();
  });
});
