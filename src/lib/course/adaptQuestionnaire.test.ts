import { describe, it, expect } from "vitest";
import { adaptOpenQuestion, deriveMcFeedback } from "./adaptQuestionnaire";
import { encodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "@/lib/types/mcOptionKey";

describe("deriveMcFeedback", () => {
  it("returns null for ungraded questions regardless of selection", () => {
    expect(deriveMcFeedback(undefined, 0)).toBeNull();
    expect(deriveMcFeedback(undefined, 3)).toBeNull();
  });

  it("returns 'correct' when the selection matches the correct index", () => {
    expect(deriveMcFeedback(2, 2)).toBe("correct");
  });

  it("returns 'wrong' when the selection misses the correct index", () => {
    expect(deriveMcFeedback(2, 0)).toBe("wrong");
  });
});

describe("adaptOpenQuestion", () => {
  it("decodes correctEnc into correctIndex for a graded MC question", () => {
    expect(
      adaptOpenQuestion({
        id: "b1",
        type: "multiple_choice",
        prompt: "What is 2+2?",
        options: { A: "3", B: "4", C: "5", D: "6" },
        correctEnc: encodeCorrect("b1", KEY_TO_INDEX.B),
      }),
    ).toEqual({
      id: "b1",
      prompt: "What is 2+2?",
      options: ["3", "4", "5", "6"],
      correctIndex: 1,
    });
  });

  it("leaves correctIndex undefined when correctEnc is absent (clarify-style MC)", () => {
    const adapted = adaptOpenQuestion({
      id: "c1",
      type: "multiple_choice",
      prompt: "Pick one",
      options: { A: "a", B: "b", C: "c", D: "d" },
    });
    expect(adapted.correctIndex).toBeUndefined();
  });

  it("leaves correctIndex undefined when correctEnc is bound to another question", () => {
    const adapted = adaptOpenQuestion({
      id: "q1",
      type: "multiple_choice",
      prompt: "?",
      options: { A: "1", B: "2", C: "3", D: "4" },
      correctEnc: encodeCorrect("q2", 0),
    });
    expect(adapted.correctIndex).toBeUndefined();
  });

  it("adapts free-text questions to ChoiceQuestion with empty options array", () => {
    expect(
      adaptOpenQuestion({ id: "f1", type: "free_text", prompt: "Why are you learning?" }),
    ).toEqual({ id: "f1", prompt: "Why are you learning?", options: [] });
  });
});
