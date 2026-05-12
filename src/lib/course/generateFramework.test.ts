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
import type { Course } from "@/db/schema";
import type { FrameworkJsonb } from "@/lib/types/jsonb";

// --- fixtures ---------------------------------------------------------------

const COURSE_ID = "c1";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const TOPIC = "Rust ownership";

/** Minimal valid ClarificationJsonb — discriminated union requires this shape. */
const CLARIFICATION = {
  questions: [
    { id: "q1", text: "What is your goal?", type: "free_text" as const },
    { id: "q2", text: "Background?", type: "free_text" as const },
  ],
  answers: [
    { questionId: "q1", answer: "Build systems software." },
    { questionId: "q2", answer: "C++ background." },
  ],
};

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
 * Minimal valid `Framework` (camelCase, as `parseFrameworkResponse` emits).
 * One tier, estimatedStartingTier in tier set, baselineScopeTiers includes it.
 */
const PARSED_FRAMEWORK = {
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
      parsed: { framework: PARSED_FRAMEWORK, raw: "<framework>{}</framework>" },
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(SCOPING_COURSE);

    const result = await generateFramework({
      courseId: COURSE_ID,
      userId: USER_ID,
    });

    // nextStage advances to baseline
    expect(result.nextStage).toBe("baseline");
    // framework is returned as FrameworkJsonb (snake_case)
    expect(result.framework.estimated_starting_tier).toBe(1);
    expect(result.framework.topic).toBe(TOPIC);
    expect(result.framework.tiers[0]?.example_concepts).toBeDefined();
    // persistence called with the jsonb shape
    expect(updateCourseScopingState).toHaveBeenCalledWith(
      COURSE_ID,
      expect.objectContaining({ framework: expect.objectContaining({ topic: TOPIC }) }),
    );
    // executeTurn was called with framework parser
    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  it("idempotency: returns cached FrameworkJsonb when framework already populated", async () => {
    const storedFramework: FrameworkJsonb = {
      topic: TOPIC,
      scope_summary: "Baseline covers tiers 1, 2.",
      estimated_starting_tier: 1,
      baseline_scope_tiers: [1, 2],
      tiers: [
        {
          number: 1,
          name: "Foundations",
          description: "desc",
          example_concepts: ["x"],
        },
      ],
    };
    const courseWithFramework = {
      ...SCOPING_COURSE,
      framework: storedFramework,
    } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(courseWithFramework);

    const result = await generateFramework({ courseId: COURSE_ID, userId: USER_ID });

    expect(result.framework).toEqual(storedFramework);
    expect(result.nextStage).toBe("baseline");
    // Must NOT hit the LLM
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("throws PRECONDITION_FAILED when course status is not 'scoping'", async () => {
    const activeCourse = { ...SCOPING_COURSE, status: "active" } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(activeCourse);

    await expect(generateFramework({ courseId: COURSE_ID, userId: USER_ID })).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" },
    );
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("throws PRECONDITION_FAILED when clarification is null", async () => {
    const noClarification = { ...SCOPING_COURSE, clarification: null } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(noClarification);

    await expect(generateFramework({ courseId: COURSE_ID, userId: USER_ID })).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" },
    );
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("answer sanitisation: clarification answers pass through escapeXmlText in the prompt", async () => {
    // We verify by inspecting the userMessageContent arg passed to executeTurn
    // after clarification answers containing XML special chars are present.
    const xssCourse = {
      ...SCOPING_COURSE,
      clarification: {
        questions: [{ id: "q1", text: "Goal?", type: "free_text" as const }],
        answers: [{ questionId: "q1", answer: "<script>alert(1)</script>" }],
      },
    } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(xssCourse);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p2" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: { framework: PARSED_FRAMEWORK, raw: "<framework>{}</framework>" },
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(xssCourse);

    await generateFramework({ courseId: COURSE_ID, userId: USER_ID });

    const callArgs = vi.mocked(executeTurn).mock.calls[0]?.[0];
    expect(callArgs?.userMessageContent).toContain("&lt;script&gt;");
    expect(callArgs?.userMessageContent).not.toContain("<script>");
  });
});
