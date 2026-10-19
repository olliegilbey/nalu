import { describe, it, expect } from "vitest";
import { deriveStrandedScopingTurn } from "./deriveStrandedScopingTurn";
import type { CourseState, ScopingQuestionnaireForClient } from "./getState";
import type { FrameworkJsonb } from "@/lib/types/jsonb";

const clarification: ScopingQuestionnaireForClient = {
  userMessage: "Let's narrow this down.",
  questions: [{ id: "q1", type: "free_text", prompt: "Why?" }],
  responses: [],
};

const framework: FrameworkJsonb = {
  userMessage: "Here's your ladder.",
  tiers: [{ number: 1, name: "Foundations", description: "Numbers", exampleConcepts: [] }],
  estimatedStartingTier: 1,
  baselineScopeTiers: [1],
};

const baseline: ScopingQuestionnaireForClient = {
  userMessage: "Quick check.",
  questions: [
    {
      id: "b1",
      type: "multiple_choice",
      prompt: "Pick one",
      options: { A: "a", B: "b", C: "c", D: "d" },
      correctEnc: "unused",
    },
    { id: "b2", type: "free_text", prompt: "Explain" },
    {
      id: "b3",
      type: "multiple_choice",
      prompt: "Pick another",
      options: { A: "a", B: "b", C: "c", D: "d" },
      correctEnc: "unused",
    },
  ],
  responses: [],
};

function state(overrides: Partial<CourseState>): CourseState {
  return {
    courseId: "c",
    status: "scoping",
    topic: "Linear algebra",
    clarification,
    framework: null,
    baseline: null,
    scopingResult: null,
    ...overrides,
  };
}

describe("deriveStrandedScopingTurn", () => {
  it("returns null while the clarify questions still await answers", () => {
    expect(deriveStrandedScopingTurn(state({}))).toBeNull();
  });

  it("returns the framework Turn with the saved answers when no framework landed", () => {
    const saved = { ...clarification, responses: [{ questionId: "q1", freetext: "an exam" }] };
    expect(deriveStrandedScopingTurn(state({ clarification: saved }))).toEqual({
      kind: "framework",
      responses: [{ questionId: "q1", freetext: "an exam" }],
    });
  });

  it("returns null once the framework landed and the baseline is not yet built", () => {
    // The hook re-fires the baseline Turn on mount, so it needs no Retry here.
    const saved = { ...clarification, responses: [{ questionId: "q1", freetext: "an exam" }] };
    expect(deriveStrandedScopingTurn(state({ clarification: saved, framework }))).toBeNull();
  });

  it("returns null while the baseline questions still await answers", () => {
    expect(deriveStrandedScopingTurn(state({ framework, baseline }))).toBeNull();
  });

  it("returns the scoping-close Turn with the saved answers in the submitBaseline wire shape", () => {
    const saved: ScopingQuestionnaireForClient = {
      ...baseline,
      responses: [
        { questionId: "b1", choice: "C" },
        { questionId: "b2", freetext: "because" },
        { questionId: "b3", freetext: "not sure" },
      ],
    };
    expect(deriveStrandedScopingTurn(state({ framework, baseline: saved }))).toEqual({
      kind: "scopingClose",
      answers: [
        { id: "b1", kind: "mc", selected: "C" },
        { id: "b2", kind: "freetext", text: "because", fromEscape: false },
        // Typed text on an MC question came through the free-text escape.
        { id: "b3", kind: "freetext", text: "not sure", fromEscape: true },
      ],
    });
  });

  it("returns null once scoping has closed", () => {
    const closed: ScopingQuestionnaireForClient = {
      ...baseline,
      responses: [{ questionId: "b1", choice: "A" }],
    };
    expect(
      deriveStrandedScopingTurn(
        state({
          status: "active",
          framework,
          baseline: closed,
          scopingResult: { closingMessage: "done", startingTier: 1 },
        }),
      ),
    ).toBeNull();
  });

  it("throws when a saved clarify response carries no free text", () => {
    // Clarify is free-text only; generateFramework never saves a choice.
    const corrupt = { ...clarification, responses: [{ questionId: "q1", choice: "A" as const }] };
    expect(() => deriveStrandedScopingTurn(state({ clarification: corrupt }))).toThrow(/q1/);
  });
});
