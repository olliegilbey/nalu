import { describe, it, expect, vi, beforeEach } from "vitest";
import { expectNoPlaintextAnswerKey } from "@/lib/testing/expectNoPlaintextAnswerKey";
import { getState } from "./getState";

vi.mock("@/db/queries/courses", () => ({
  getCourseById: vi.fn(),
  NotFoundError: class NotFoundError extends Error {
    constructor(entity: string, id: string) {
      super(`${entity} not found: ${id}`);
    }
  },
}));

import { getCourseById, NotFoundError } from "@/db/queries/courses";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "@/lib/types/mcOptionKey";

const mockedGetCourse = vi.mocked(getCourseById);

/** Stored clarify questions: an ungraded MC (no `correct`) and a free-text question. */
const STORED_CLARIFICATION = {
  userMessage: "let's clarify",
  questions: [
    {
      id: "q1",
      type: "multiple_choice",
      prompt: "Pick a goal",
      options: { A: "a", B: "b", C: "c", D: "d" },
      freetextRubric: "no grading — informational",
    },
    { id: "q2", type: "free_text", prompt: "Why?", freetextRubric: "no grading — informational" },
  ],
  responses: [{ questionId: "q1", choice: "A" }],
};

/** Stored baseline questions: a graded MC (key `C`) and a free-text question with a rubric. */
const STORED_BASELINE_QUESTIONS = [
  {
    id: "b1",
    type: "multiple_choice",
    prompt: "2+2?",
    options: { A: "3", B: "5", C: "4", D: "6" },
    correct: "C",
    freetextRubric: "names four",
    conceptName: "addition",
    tier: 1,
  },
  {
    id: "b2",
    type: "free_text",
    prompt: "Why does 2+2 make 4?",
    freetextRubric: "explains counting on from two",
    conceptName: "counting",
    tier: 1,
  },
];

beforeEach(() => {
  mockedGetCourse.mockReset();
});

describe("getState", () => {
  it("projects a scoping row with only topic + clarification", async () => {
    mockedGetCourse.mockResolvedValue({
      id: "c1",
      userId: "u1",
      topic: "Linear algebra",
      status: "scoping",
      clarification: {
        userMessage: "let's clarify",
        questions: [{ id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" }],
        responses: [],
      },
      framework: null,
      baseline: null,
      summary: null,
      startingTier: null,
      currentTier: 1,
      totalXp: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      summaryUpdatedAt: null,
    } as unknown as Awaited<ReturnType<typeof getCourseById>>);

    const result = await getState({ userId: "u1", courseId: "c1" });
    expect(result.courseId).toBe("c1");
    expect(result.status).toBe("scoping");
    expect(result.topic).toBe("Linear algebra");
    expect(result.clarification).not.toBeNull();
    expect(result.framework).toBeNull();
    expect(result.baseline).toBeNull();
    expect(result.scopingResult).toBeNull();
  });

  it("emits scopingResult for an active course", async () => {
    mockedGetCourse.mockResolvedValue({
      id: "c2",
      userId: "u1",
      topic: "T",
      status: "active",
      clarification: { userMessage: "c", questions: [], responses: [] },
      framework: {
        userMessage: "f",
        tiers: [{ number: 1, name: "n", description: "d", exampleConcepts: [] }],
        estimatedStartingTier: 1,
        baselineScopeTiers: [1],
      },
      baseline: {
        userMessage: "closing message",
        questions: [],
        responses: [],
        gradings: [],
        startingTier: 1,
      },
      summary: "s",
      startingTier: 1,
      currentTier: 1,
      totalXp: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
      summaryUpdatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getCourseById>>);

    const result = await getState({ userId: "u1", courseId: "c2" });
    expect(result.scopingResult).not.toBeNull();
    expect(result.scopingResult?.closingMessage).toBe("closing message");
    expect(result.scopingResult?.startingTier).toBe(1);
  });

  it("ships no plaintext answer key before submit: rubrics dropped, MC key encoded", async () => {
    mockedGetCourse.mockResolvedValue({
      id: "c4",
      userId: "u1",
      topic: "Arithmetic",
      status: "scoping",
      clarification: STORED_CLARIFICATION,
      framework: {
        userMessage: "f",
        tiers: [{ number: 1, name: "n", description: "d", exampleConcepts: [] }],
        estimatedStartingTier: 1,
        baselineScopeTiers: [1],
      },
      baseline: {
        userMessage: "Quick check.",
        questions: STORED_BASELINE_QUESTIONS,
        responses: [],
        gradings: [],
      },
    } as unknown as Awaited<ReturnType<typeof getCourseById>>);

    const result = await getState({ userId: "u1", courseId: "c4" });

    expectNoPlaintextAnswerKey(result);
    // The client keeps instant MC feedback: the key arrives id-bound and encoded.
    const [mc, ft] = result.baseline?.questions ?? [];
    if (mc?.type !== "multiple_choice") throw new Error("expected an MC question");
    expect(decodeCorrect("b1", mc.correctEnc ?? "")).toBe(KEY_TO_INDEX.C);
    expect(ft).toEqual({ id: "b2", type: "free_text", prompt: "Why does 2+2 make 4?", tier: 1 });
    // An ungraded clarify MC has no key to encode.
    const [clarifyMc] = result.clarification?.questions ?? [];
    if (clarifyMc?.type !== "multiple_choice") throw new Error("expected an MC question");
    expect(clarifyMc.correctEnc).toBeUndefined();
    // Saved answers still ship, so the chat can render them.
    expect(result.clarification?.responses).toEqual([{ questionId: "q1", choice: "A" }]);
  });

  it("ships no plaintext answer key after close either", async () => {
    mockedGetCourse.mockResolvedValue({
      id: "c5",
      userId: "u1",
      topic: "Arithmetic",
      status: "active",
      clarification: STORED_CLARIFICATION,
      framework: {
        userMessage: "f",
        tiers: [{ number: 1, name: "n", description: "d", exampleConcepts: [] }],
        estimatedStartingTier: 1,
        baselineScopeTiers: [1],
      },
      baseline: {
        userMessage: "closing message",
        questions: STORED_BASELINE_QUESTIONS,
        responses: [
          { questionId: "b1", choice: "C" },
          { questionId: "b2", freetext: "counting" },
        ],
        gradings: [],
        summarySeed: "seed",
        startingTier: 1,
      },
    } as unknown as Awaited<ReturnType<typeof getCourseById>>);

    const result = await getState({ userId: "u1", courseId: "c5" });

    expectNoPlaintextAnswerKey(result);
    expect(result.scopingResult?.startingTier).toBe(1);
  });

  it("re-throws NotFoundError from the query layer", async () => {
    mockedGetCourse.mockRejectedValue(new NotFoundError("course", "c3"));
    await expect(getState({ userId: "u1", courseId: "c3" })).rejects.toThrow(NotFoundError);
  });
});
