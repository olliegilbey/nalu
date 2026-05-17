import { describe, it, expect } from "vitest";
import { deriveTurns } from "./deriveTurns";
import type { CourseState } from "./getState";

function baseState(overrides: Partial<CourseState>): CourseState {
  return {
    courseId: "c",
    status: "scoping",
    topic: "Linear algebra",
    clarification: null,
    framework: null,
    baseline: null,
    scopingResult: null,
    ...overrides,
  };
}

describe("deriveTurns", () => {
  it("emits only user-topic when only topic exists", () => {
    const turns = deriveTurns(baseState({}));
    expect(turns).toEqual([{ kind: "user-topic", content: "Linear algebra" }]);
  });

  it("adds llm-clarify-intro when clarification is present", () => {
    const turns = deriveTurns(
      baseState({
        clarification: {
          userMessage: "Let's narrow this down.",
          questions: [{ id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" }],
          responses: [],
        },
      }),
    );
    expect(turns).toEqual([
      { kind: "user-topic", content: "Linear algebra" },
      { kind: "llm-clarify-intro", content: "Let's narrow this down." },
    ]);
  });

  it("emits user-clarify-answers + llm-framework once framework lands", () => {
    const turns = deriveTurns(
      baseState({
        clarification: {
          userMessage: "Let's narrow this down.",
          questions: [
            { id: "q1", type: "free_text", prompt: "Why are you learning?", freetextRubric: "n/a" },
            { id: "q2", type: "free_text", prompt: "Prior experience?", freetextRubric: "n/a" },
          ],
          responses: [
            { questionId: "q1", freetext: "to pass an exam" },
            { questionId: "q2", freetext: "calc 1" },
          ],
        },
        framework: {
          userMessage: "Here's your ladder.",
          tiers: [
            { number: 1, name: "Foundations", description: "Numbers", exampleConcepts: [] },
            { number: 2, name: "Vectors", description: "Magnitude", exampleConcepts: [] },
          ],
          estimatedStartingTier: 1,
          baselineScopeTiers: [1, 2],
        },
      }),
    );

    const kinds = turns.map((t) => t.kind);
    expect(kinds).toEqual([
      "user-topic",
      "llm-clarify-intro",
      "user-clarify-answers",
      "llm-framework",
    ]);
    const userAnswers = turns.find((t) => t.kind === "user-clarify-answers")!;
    expect(userAnswers).toMatchObject({
      content: expect.stringContaining("Why are you learning?"),
    });
    expect(userAnswers).toMatchObject({
      content: expect.stringContaining("to pass an exam"),
    });
    const framework = turns.find((t) => t.kind === "llm-framework")!;
    expect(framework).toMatchObject({
      userMessage: "Here's your ladder.",
      tiers: [
        { number: 1, name: "Foundations", description: "Numbers" },
        { number: 2, name: "Vectors", description: "Magnitude" },
      ],
    });
  });

  it("adds llm-baseline-intro once baseline questions exist (still scoping)", () => {
    const turns = deriveTurns(
      baseState({
        clarification: {
          userMessage: "c",
          questions: [],
          responses: [],
        },
        framework: {
          userMessage: "f",
          tiers: [],
          estimatedStartingTier: 1,
          baselineScopeTiers: [1],
        },
        baseline: {
          userMessage: "Let's check what you know.",
          questions: [],
          responses: [],
          gradings: [],
        },
      }),
    );

    const intro = turns.find((t) => t.kind === "llm-baseline-intro")!;
    expect(intro).toEqual({ kind: "llm-baseline-intro", content: "Let's check what you know." });
    expect(turns.find((t) => t.kind === "move-on-cta")).toBeUndefined();
  });

  it("emits user-baseline-answers + close + move-on-cta when scopingResult lands", () => {
    const turns = deriveTurns(
      baseState({
        status: "active",
        clarification: {
          userMessage: "c",
          questions: [],
          responses: [],
        },
        framework: {
          userMessage: "f",
          tiers: [],
          estimatedStartingTier: 1,
          baselineScopeTiers: [1],
        },
        baseline: {
          userMessage: "Nicely done.",
          questions: [
            {
              id: "b1",
              type: "multiple_choice",
              prompt: "What is 2+2?",
              options: { A: "3", B: "4", C: "5", D: "6" },
              correct: "B",
              freetextRubric: "n/a",
              conceptName: "addition",
              tier: 1,
            },
          ],
          responses: [{ questionId: "b1", choice: "B" }],
          gradings: [],
          startingTier: 1,
        } as unknown as NonNullable<CourseState["baseline"]>,
        scopingResult: { closingMessage: "Nicely done.", startingTier: 1 },
      }),
    );

    const kinds = turns.map((t) => t.kind);
    expect(kinds).toEqual([
      "user-topic",
      "llm-clarify-intro",
      "user-clarify-answers",
      "llm-framework",
      "llm-baseline-intro",
      "user-baseline-answers",
      "llm-baseline-close",
      "move-on-cta",
    ]);
    expect(turns.at(-1)).toEqual({ kind: "move-on-cta", nextWaveNumber: 1 });
  });
});
