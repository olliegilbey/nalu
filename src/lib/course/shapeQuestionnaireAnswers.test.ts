import { describe, it, expect } from "vitest";
import { matchOptionIndex, shapeQuestionnaireAnswers } from "./shapeQuestionnaireAnswers";
import type { ChoiceQuestion } from "./adaptQuestionnaire";

const capital: ChoiceQuestion = {
  id: "q1",
  prompt: "Capital of France?",
  options: ["Paris", "Lyon", "Nice", "Lille"],
  correctIndex: 0,
};

describe("matchOptionIndex", () => {
  it("returns the index of an option named verbatim", () => {
    expect(matchOptionIndex(capital, "Lille")).toBe(3);
  });

  it("returns null for text that is not an option verbatim", () => {
    expect(matchOptionIndex(capital, "paris")).toBeNull();
    expect(matchOptionIndex(capital, "Paris, I think")).toBeNull();
  });

  it("returns null for a free-text question", () => {
    expect(matchOptionIndex({ id: "q2", prompt: "Why?", options: [] }, "Paris")).toBeNull();
  });

  it("returns null past the four MC letters", () => {
    const fiveOptions = { ...capital, options: [...capital.options, "Brest"] };
    expect(matchOptionIndex(fiveOptions, "Brest")).toBeNull();
  });
});

describe("shapeQuestionnaireAnswers", () => {
  it("ships a verbatim answer as MC and anything else as free text", () => {
    const shaped = shapeQuestionnaireAnswers([
      { question: capital, answer: "Lille" },
      { question: capital, answer: "paris" },
    ]);
    expect(shaped).toEqual([
      { id: "q1", kind: "mc", selected: "D" },
      { id: "q1", kind: "freetext", text: "paris", fromEscape: true },
    ]);
  });
});
