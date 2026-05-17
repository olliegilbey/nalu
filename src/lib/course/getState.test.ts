import { describe, it, expect, vi, beforeEach } from "vitest";
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

const mockedGetCourse = vi.mocked(getCourseById);

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

  it("re-throws NotFoundError from the query layer", async () => {
    mockedGetCourse.mockRejectedValue(new NotFoundError("course", "c3"));
    await expect(getState({ userId: "u1", courseId: "c3" })).rejects.toThrow(NotFoundError);
  });
});
