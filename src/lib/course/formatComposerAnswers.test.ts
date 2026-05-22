import { describe, it, expect } from "vitest";
import { formatComposerAnswers } from "./formatComposerAnswers";

describe("formatComposerAnswers", () => {
  it("formats answers as a numbered prose list", () => {
    expect(
      formatComposerAnswers([
        {
          question: { id: "q1", prompt: "Capital of France?", options: ["Paris"] },
          answer: "Paris",
        },
        { question: { id: "q2", prompt: "2 + 2?", options: [] }, answer: "4" },
      ]),
    ).toBe("1. Capital of France? — Paris\n2. 2 + 2? — 4");
  });

  it("returns an empty string for no answers", () => {
    expect(formatComposerAnswers([])).toBe("");
  });
});
