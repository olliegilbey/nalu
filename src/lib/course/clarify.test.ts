import { describe, it, expect, vi, beforeEach } from "vitest";
import { clarify } from "./clarify";

vi.mock("@/lib/turn/executeTurn", () => ({ executeTurn: vi.fn() }));
vi.mock("@/db/queries/courses", async () => {
  const actual =
    await vi.importActual<typeof import("@/db/queries/courses")>("@/db/queries/courses");
  return {
    ...actual,
    createCourse: vi.fn(),
    getCourseById: vi.fn(),
    updateCourseScopingState: vi.fn(),
  };
});
vi.mock("@/db/queries/scopingPasses", () => ({
  ensureOpenScopingPass: vi.fn(),
}));

import { executeTurn } from "@/lib/turn/executeTurn";
import { createCourse, getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import type { Course } from "@/db/schema";

const USER = "11111111-1111-1111-1111-111111111111";
// Minimal stub — only fields accessed by clarify. Cast via unknown for TS.
const COURSE = { id: "c1", userId: USER, topic: "Rust", clarification: null } as unknown as Course;

beforeEach(() => {
  vi.mocked(executeTurn).mockReset();
  vi.mocked(createCourse).mockReset();
  vi.mocked(getCourseById).mockReset();
  vi.mocked(updateCourseScopingState).mockReset();
  vi.mocked(ensureOpenScopingPass).mockReset();
});

describe("clarify", () => {
  it("creates a course, opens a scoping pass, runs executeTurn, persists projection, returns nextStage", async () => {
    vi.mocked(createCourse).mockResolvedValue(COURSE);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: {
        questions: ["Q1", "Q2"],
        raw: '<response>x</response><questions>["Q1","Q2"]</questions>',
      },
      // Full LanguageModelUsage shape (AI SDK v5) — detail sub-objects required.
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      },
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(COURSE);

    const out = await clarify({ userId: USER, topic: "Rust" });
    expect(out.courseId).toBe(COURSE.id);
    expect(out.questions).toEqual(["Q1", "Q2"]);
    expect(out.nextStage).toBe("framework");
    expect(updateCourseScopingState).toHaveBeenCalledWith(
      COURSE.id,
      expect.objectContaining({ clarification: expect.anything() }),
    );
  });

  it("is idempotent: returns cached projection when clarification is already populated", async () => {
    // Existing course already has clarification — must NOT call executeTurn.
    // Use a valid JSONB shape (clarificationJsonbSchema requires discriminated union questions).
    const existingId = "existing";
    const existing = {
      ...COURSE,
      id: existingId,
      clarification: {
        questions: [
          { id: "q1", text: "A", type: "free_text" },
          { id: "q2", text: "B", type: "free_text" },
        ],
        answers: [],
      },
    } as unknown as Course;
    vi.mocked(createCourse).mockResolvedValue(existing);
    const out = await clarify({ userId: USER, topic: "Rust" });
    // idempotency branch maps .text out of the stored JSONB shape
    expect(out.questions).toEqual(["A", "B"]);
    expect(executeTurn).not.toHaveBeenCalled();
  });
});
