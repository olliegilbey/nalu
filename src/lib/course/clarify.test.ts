import { describe, it, expect, vi, beforeEach } from "vitest";
import { clarify } from "./clarify";

vi.mock("@/lib/turn/executeTurn", () => ({ executeTurn: vi.fn() }));
vi.mock("@/db/queries/courses", async () => {
  const actual =
    await vi.importActual<typeof import("@/db/queries/courses")>("@/db/queries/courses");
  return {
    ...actual,
    createCourse: vi.fn(),
    updateCourseScopingState: vi.fn(),
  };
});
vi.mock("@/db/queries/scopingPasses", () => ({
  ensureOpenScopingPass: vi.fn(),
}));

import { executeTurn } from "@/lib/turn/executeTurn";
import { createCourse, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import type { Course } from "@/db/schema";

const USER = "11111111-1111-1111-1111-111111111111";
// Minimal stub — only fields accessed by clarify. Cast via unknown for TS.
const COURSE = { id: "c1", userId: USER, topic: "Rust", clarification: null } as unknown as Course;

/** Minimal valid ClarifyTurn mock return — matches clarifySchema wire shape. */
const MOCK_CLARIFY_PARSED = {
  userMessage: "Let me ask a couple of questions.",
  questions: {
    questions: [
      { id: "q1", type: "free_text" as const, prompt: "What is your goal?", freetextRubric: "r" },
      {
        id: "q2",
        type: "free_text" as const,
        prompt: "What is your background?",
        freetextRubric: "r",
      },
    ],
  },
};

/** Full AI SDK v5 LlmUsage shape. */
const MOCK_USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

beforeEach(() => {
  vi.mocked(executeTurn).mockReset();
  vi.mocked(createCourse).mockReset();
  vi.mocked(updateCourseScopingState).mockReset();
  vi.mocked(ensureOpenScopingPass).mockReset();
});

describe("clarify", () => {
  it("creates a course, opens a scoping pass, runs executeTurn, persists clarification, returns nextStage", async () => {
    vi.mocked(createCourse).mockResolvedValue(COURSE);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: MOCK_CLARIFY_PARSED,
      usage: MOCK_USAGE,
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(COURSE);

    const out = await clarify({ userId: USER, topic: "Rust" });
    expect(out.courseId).toBe(COURSE.id);
    // New shape: clarification is the full ClarifyTurn wire payload.
    expect(out.clarification.questions.questions).toHaveLength(2);
    expect(out.clarification.questions.questions[0]?.prompt).toBe("What is your goal?");
    expect(out.nextStage).toBe("framework");
    // Persistence called with the JSONB shape (questions + empty responses).
    expect(updateCourseScopingState).toHaveBeenCalledWith(
      COURSE.id,
      expect.objectContaining({
        clarification: expect.objectContaining({ questions: expect.any(Array), responses: [] }),
      }),
    );
  });

  it("is idempotent: returns cached clarification when already populated", async () => {
    // Existing course already has clarification — must NOT call executeTurn.
    const existingId = "existing";
    const existing = {
      ...COURSE,
      id: existingId,
      clarification: {
        questions: [
          {
            id: "q1",
            type: "free_text" as const,
            prompt: "A",
            freetextRubric: "rubric-a",
          },
          {
            id: "q2",
            type: "free_text" as const,
            prompt: "B",
            freetextRubric: "rubric-b",
          },
        ],
        responses: [],
      },
    } as unknown as Course;
    vi.mocked(createCourse).mockResolvedValue(existing);
    const out = await clarify({ userId: USER, topic: "Rust" });
    // Idempotency branch: rebuilds ClarifyTurn from stored JSONB.
    expect(out.clarification.questions.questions).toHaveLength(2);
    expect(out.clarification.questions.questions[0]?.prompt).toBe("A");
    expect(executeTurn).not.toHaveBeenCalled();
  });
});
