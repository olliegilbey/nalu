import { describe, it, expect } from "vitest";
import { deriveActiveScopingQuestionnaire } from "./deriveActiveScopingQuestionnaire";
import type { CourseState } from "./getState";
import type { ScopingQuestionnaireForClient } from "./redactQuestionnaire";
import type { FrameworkJsonb } from "@/lib/types/jsonb";
import { encodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "@/lib/types/mcOptionKey";

const clarification: ScopingQuestionnaireForClient = {
  userMessage: "Let's narrow this down.",
  questions: [
    { id: "q1", type: "free_text", prompt: "Why?" },
    { id: "q2", type: "free_text", prompt: "How far?" },
  ],
  responses: [],
};
const answeredClarification: ScopingQuestionnaireForClient = {
  ...clarification,
  responses: [{ questionId: "q1", freetext: "Curious" }],
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
      correctEnc: encodeCorrect("b1", KEY_TO_INDEX.B),
    },
    { id: "b2", type: "free_text", prompt: "Explain" },
  ],
  responses: [],
};

function state(overrides: Partial<CourseState>): CourseState {
  return {
    courseId: "c",
    status: "scoping",
    topic: "Linear algebra",
    clarification: null,
    framework: null,
    baseline: null,
    scopingResult: null,
    totalXp: 0,
    ...overrides,
  };
}

describe("deriveActiveScopingQuestionnaire", () => {
  it("returns null before the clarify questions exist", () => {
    expect(deriveActiveScopingQuestionnaire(state({}))).toBeNull();
  });

  it("returns the clarify questionnaire while it awaits answers", () => {
    expect(deriveActiveScopingQuestionnaire(state({ clarification }))).toEqual({
      kind: "clarify",
      questions: [
        { id: "q1", prompt: "Why?", options: [] },
        { id: "q2", prompt: "How far?", options: [] },
      ],
      questionsKey: "q1|q2",
      persistKey: "nalu:scoping:c:clarify",
    });
  });

  it("returns null once the clarify answers are saved, before the framework lands", () => {
    expect(deriveActiveScopingQuestionnaire(state({ clarification: answeredClarification }))).toBe(
      null,
    );
  });

  it("returns null for unanswered clarify questions once a framework exists", () => {
    expect(deriveActiveScopingQuestionnaire(state({ clarification, framework }))).toBeNull();
  });

  it("returns the baseline questionnaire while it awaits answers", () => {
    const s = state({ clarification: answeredClarification, framework, baseline });
    expect(deriveActiveScopingQuestionnaire(s)).toEqual({
      kind: "baseline",
      questions: [
        // Instant MC feedback: the index decodes from the id-bound `correctEnc`.
        { id: "b1", prompt: "Pick one", options: ["a", "b", "c", "d"], correctIndex: 1 },
        { id: "b2", prompt: "Explain", options: [] },
      ],
      questionsKey: "b1|b2",
      persistKey: "nalu:scoping:c:baseline",
    });
  });

  it("returns null once the baseline answers are saved", () => {
    const answered: ScopingQuestionnaireForClient = {
      ...baseline,
      responses: [{ questionId: "b1", choice: "B" }],
    };
    const s = state({ clarification: answeredClarification, framework, baseline: answered });
    expect(deriveActiveScopingQuestionnaire(s)).toBeNull();
  });

  it("returns null once scoping has closed", () => {
    const s = state({
      status: "active",
      clarification: answeredClarification,
      framework,
      baseline,
    });
    expect(deriveActiveScopingQuestionnaire(s)).toBeNull();
  });
});
