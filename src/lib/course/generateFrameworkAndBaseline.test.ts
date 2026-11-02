import { describe, it, expect, vi, beforeEach } from "vitest";
import { expectNoPlaintextAnswerKey } from "@/lib/testing/expectNoPlaintextAnswerKey";

// Mock all external dependencies before importing SUT.
vi.mock("@/lib/turn/executeTurn", () => ({ executeTurn: vi.fn() }));
vi.mock("@/db/queries/courses", async () => {
  const actual =
    await vi.importActual<typeof import("@/db/queries/courses")>("@/db/queries/courses");
  return {
    ...actual,
    getCourseById: vi.fn(),
  };
});
vi.mock("@/db/queries/courses.scoping", () => ({
  updateCourseScopingState: vi.fn(),
}));
vi.mock("@/db/queries/scopingPasses", () => ({
  ensureOpenScopingPass: vi.fn(),
}));

import { generateFrameworkAndBaseline } from "./generateFrameworkAndBaseline";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById } from "@/db/queries/courses";
import { updateCourseScopingState } from "@/db/queries/courses.scoping";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { SCOPING } from "@/lib/config/tuning";
import { frameworkAndBaselineSchema } from "@/lib/prompts/frameworkAndBaseline";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "@/lib/types/mcOptionKey";
import type { Course } from "@/db/schema";
import type { BaselineJsonb, FrameworkJsonb } from "@/lib/types/jsonb";

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
  baseline: null,
} as unknown as Course;

/**
 * Minimal Framework (camelCase, as frameworkSchema emits).
 * estimatedStartingTier in tier set, baselineScopeTiers includes it.
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

/** A graded MC baseline question on `tier`. */
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

/** Baseline half of the merged response: flat `{ userMessage, questions }`, 7 questions in scope. */
const PARSED_BASELINE = {
  userMessage: "Here is your baseline.",
  questions: [1, 2, 1, 2, 1, 2, 1].map((tier, i) => mcQuestion(`b${i + 1}`, tier)),
};

/** The merged Turn's parsed response: both halves in one object. */
const PARSED = { framework: PARSED_FRAMEWORK, baseline: PARSED_BASELINE };

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

describe("generateFrameworkAndBaseline", () => {
  /** Mock one successful merged Turn against `course`. */
  function mockTurn(course: Course) {
    vi.mocked(getCourseById).mockResolvedValue(course);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({ parsed: PARSED, usage: MOCK_USAGE });
    vi.mocked(updateCourseScopingState).mockResolvedValue(course);
  }

  it("happy path: one merged Turn against the merged schema, returns both artifacts", async () => {
    mockTurn(SCOPING_COURSE);

    const result = await generateFrameworkAndBaseline({
      courseId: COURSE_ID,
      userId: USER_ID,
      responses: RESPONSES,
    });

    // One LLM call builds both artifacts.
    expect(executeTurn).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(executeTurn).mock.calls[0]?.[0];
    expect(callArgs?.responseSchema).toBe(frameworkAndBaselineSchema);
    expect(callArgs?.userMessageContent).toContain(
      "<stage>generate framework and baseline</stage>",
    );
    // The client skips the baseline Turn: the next stage is answering.
    expect(result.nextStage).toBe("answering");
    expect(result.framework.estimatedStartingTier).toBe(1);
    expect(result.baseline.questions.questions).toHaveLength(7);
  });

  it("persists both columns in one write, in the shapes the two old steps wrote", async () => {
    mockTurn(SCOPING_COURSE);

    await generateFrameworkAndBaseline({
      courseId: COURSE_ID,
      userId: USER_ID,
      responses: RESPONSES,
    });

    // Two writes: the clarify answers before the LLM call, then both artifacts.
    expect(updateCourseScopingState).toHaveBeenCalledTimes(2);
    expect(updateCourseScopingState).toHaveBeenNthCalledWith(1, COURSE_ID, {
      clarification: { ...CLARIFICATION, responses: RESPONSES },
    });
    const framework: FrameworkJsonb = PARSED_FRAMEWORK;
    const baseline: BaselineJsonb = {
      userMessage: PARSED_BASELINE.userMessage,
      questions: PARSED_BASELINE.questions,
      responses: [],
      gradings: [],
    };
    // One write, so no reader ever sees a framework without its baseline.
    expect(updateCourseScopingState).toHaveBeenNthCalledWith(2, COURSE_ID, { framework, baseline });
  });

  it("returns no plaintext answer key: rubric dropped, MC correct sent as correctEnc", async () => {
    mockTurn(SCOPING_COURSE);

    const result = await generateFrameworkAndBaseline({
      courseId: COURSE_ID,
      userId: USER_ID,
      responses: RESPONSES,
    });

    expectNoPlaintextAnswerKey(result);
    const [first] = result.baseline.questions.questions;
    if (first?.type !== "multiple_choice") throw new Error("expected an MC question");
    // Every fixture question's key is A.
    expect(decodeCorrect("b1", first.correctEnc ?? "")).toBe(KEY_TO_INDEX.A);
  });

  it("idempotency: returns the stored framework and baseline without an LLM call", async () => {
    const storedFramework: FrameworkJsonb = {
      userMessage: "Cached framework framing.",
      estimatedStartingTier: 1,
      baselineScopeTiers: [1, 2],
      tiers: [{ number: 1, name: "Foundations", description: "desc", exampleConcepts: ["x"] }],
    };
    const storedBaseline: BaselineJsonb = {
      userMessage: "Cached baseline framing.",
      questions: PARSED_BASELINE.questions,
      responses: [],
      gradings: [],
    };
    vi.mocked(getCourseById).mockResolvedValue({
      ...SCOPING_COURSE,
      framework: storedFramework,
      baseline: storedBaseline,
    } as unknown as Course);

    const result = await generateFrameworkAndBaseline({
      courseId: COURSE_ID,
      userId: USER_ID,
      responses: RESPONSES,
    });

    expect(result.framework).toEqual(storedFramework);
    expect(result.baseline.userMessage).toBe("Cached baseline framing.");
    expect(result.baseline.questions.questions).toHaveLength(7);
    expect(result.nextStage).toBe("answering");
    // The replay is projected too: stored keys stay server-side.
    expectNoPlaintextAnswerKey(result);
    // Must NOT hit the LLM or write.
    expect(executeTurn).not.toHaveBeenCalled();
    expect(updateCourseScopingState).not.toHaveBeenCalled();
  });

  // A course framed before the merge (issue #15) can hold a framework with no
  // baseline. The merged Turn reruns and writes both, so the pair agrees.
  it("a framework with no baseline reruns the merged Turn and rewrites both columns", async () => {
    const preMergeCourse = {
      ...SCOPING_COURSE,
      framework: { ...PARSED_FRAMEWORK, userMessage: "Old framing." },
    } as unknown as Course;
    mockTurn(preMergeCourse);

    const result = await generateFrameworkAndBaseline({
      courseId: COURSE_ID,
      userId: USER_ID,
      responses: RESPONSES,
    });

    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(result.framework.userMessage).toBe("Here is the framework.");
    expect(updateCourseScopingState).toHaveBeenLastCalledWith(
      COURSE_ID,
      expect.objectContaining({
        framework: expect.objectContaining({ userMessage: "Here is the framework." }),
        baseline: expect.objectContaining({ userMessage: "Here is your baseline." }),
      }),
    );
  });

  it("throws PRECONDITION_FAILED when course status is not 'scoping'", async () => {
    const activeCourse = { ...SCOPING_COURSE, status: "active" } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(activeCourse);

    await expect(
      generateFrameworkAndBaseline({ courseId: COURSE_ID, userId: USER_ID, responses: RESPONSES }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("throws PRECONDITION_FAILED when clarification is null", async () => {
    const noClarification = { ...SCOPING_COURSE, clarification: null } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(noClarification);

    await expect(
      generateFrameworkAndBaseline({ courseId: COURSE_ID, userId: USER_ID, responses: RESPONSES }),
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
        // stored responses are empty — the step uses params.responses
        responses: [],
      },
    } as unknown as Course;
    vi.mocked(getCourseById).mockResolvedValue(xssCourse);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p2" } as never);
    vi.mocked(executeTurn).mockResolvedValue({ parsed: PARSED, usage: MOCK_USAGE });
    vi.mocked(updateCourseScopingState).mockResolvedValue(xssCourse);

    await generateFrameworkAndBaseline({
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
      generateFrameworkAndBaseline({ courseId: COURSE_ID, userId: USER_ID, responses: [] }),
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
      generateFrameworkAndBaseline({ courseId: COURSE_ID, userId: USER_ID, responses: tooMany }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  // Case 8: responses length doesn't match questions length — strict mismatch guard.
  it("throws BAD_REQUEST when responses.length does not match questions.length", async () => {
    // SCOPING_COURSE has 2 questions; supply only 1 response.
    vi.mocked(getCourseById).mockResolvedValue(SCOPING_COURSE);

    await expect(
      generateFrameworkAndBaseline({
        courseId: COURSE_ID,
        userId: USER_ID,
        responses: [{ questionId: "q1", freetext: "only one" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(executeTurn).not.toHaveBeenCalled();
  });
});
