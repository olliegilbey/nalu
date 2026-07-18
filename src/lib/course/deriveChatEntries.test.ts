import { describe, it, expect } from "vitest";
import { deriveChatEntries, formatAnswers } from "./deriveChatEntries";
import type { CourseState } from "./getState";
import type { V3Question, V3Response } from "@/lib/types/jsonb";

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

describe("deriveChatEntries", () => {
  it("emits only user-text (topic) when only topic exists", () => {
    const chatEntries = deriveChatEntries(baseState({}));
    expect(chatEntries).toEqual([{ kind: "user-text", content: "Linear algebra" }]);
  });

  it("adds assistant-text (clarify intro) when clarification is present", () => {
    const chatEntries = deriveChatEntries(
      baseState({
        clarification: {
          userMessage: "Let's narrow this down.",
          questions: [{ id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" }],
          responses: [],
        },
      }),
    );
    expect(chatEntries).toEqual([
      { kind: "user-text", content: "Linear algebra" },
      { kind: "assistant-text", content: "Let's narrow this down." },
    ]);
  });

  it("emits user-questionnaire-answers + assistant-text-with-framework once framework lands", () => {
    const chatEntries = deriveChatEntries(
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

    const kinds = chatEntries.map((t) => t.kind);
    expect(kinds).toEqual([
      "user-text",
      "assistant-text",
      "user-questionnaire-answers",
      "assistant-text-with-framework",
    ]);
    // Find clarify answer entry — it's the user-questionnaire-answers between
    // the clarify-intro and the framework reveal.
    const userAnswers = chatEntries.find((t) => t.kind === "user-questionnaire-answers")!;
    expect(userAnswers).toMatchObject({
      content: expect.stringContaining("Why are you learning?"),
    });
    expect(userAnswers).toMatchObject({
      content: expect.stringContaining("to pass an exam"),
    });
    const framework = chatEntries.find((t) => t.kind === "assistant-text-with-framework")!;
    expect(framework).toMatchObject({
      userMessage: "Here's your ladder.",
      tiers: [
        { number: 1, name: "Foundations", description: "Numbers" },
        { number: 2, name: "Vectors", description: "Magnitude" },
      ],
    });
  });

  it("adds assistant-text (baseline intro) once baseline questions exist (still scoping)", () => {
    const chatEntries = deriveChatEntries(
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

    // The baseline-intro is an assistant-text entry. Distinguish it by content
    // since multiple assistant-text entries exist in the full scoping projection.
    const intro = chatEntries.find(
      (t) => t.kind === "assistant-text" && t.content === "Let's check what you know.",
    )!;
    expect(intro).toEqual({ kind: "assistant-text", content: "Let's check what you know." });
    expect(chatEntries.find((t) => t.kind === "move-on-cta")).toBeUndefined();
  });

  it("emits user-questionnaire-answers + close + move-on-cta when scopingResult lands", () => {
    const chatEntries = deriveChatEntries(
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

    const kinds = chatEntries.map((t) => t.kind);
    expect(kinds).toEqual([
      "user-text",
      "assistant-text",
      "user-questionnaire-answers",
      "assistant-text-with-framework",
      "assistant-text",
      "user-questionnaire-answers",
      "assistant-text",
      "move-on-cta",
    ]);
    expect(chatEntries.at(-1)).toEqual({
      kind: "move-on-cta",
      next: { phase: "wave", n: 1 },
    });
  });
});

describe("formatAnswers", () => {
  it("renders MC answers as the chosen option's text", () => {
    const questions: V3Question[] = [
      {
        id: "q1",
        type: "multiple_choice",
        prompt: "Color?",
        options: { A: "red", B: "blue", C: "green", D: "yellow" },
        correct: "B",
        freetextRubric: "n/a",
      },
    ];
    const responses: V3Response[] = [{ questionId: "q1", choice: "B" }];
    expect(formatAnswers(questions, responses)).toBe("1. Color? — blue");
  });

  it("renders free-text answers verbatim", () => {
    const questions: V3Question[] = [
      { id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" },
    ];
    const responses: V3Response[] = [{ questionId: "q1", freetext: "because." }];
    expect(formatAnswers(questions, responses)).toBe("1. Why? — because.");
  });

  it("falls back to Q{n} when a response references an unknown question id", () => {
    const responses: V3Response[] = [{ questionId: "missing", freetext: "x" }];
    expect(formatAnswers([], responses)).toBe("1. Q1 — x");
  });
});
