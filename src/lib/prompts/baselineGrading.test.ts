import { describe, expect, it } from "vitest";
import { gradeBaselineSchema } from "./baselineGrading";

const good = {
  userMessage: "Here is how you did.",
  gradings: [
    {
      questionId: "b1",
      conceptName: "ownership",
      verdict: "correct" as const,
      qualityScore: 5 as const,
      rationale: "Hit the key idea.",
    },
  ],
};

describe("gradeBaselineSchema", () => {
  it("accepts a well-formed grading payload", () => {
    expect(() => gradeBaselineSchema.parse(good)).not.toThrow();
  });

  it("rejects an unknown verdict", () => {
    expect(() =>
      gradeBaselineSchema.parse({
        ...good,
        gradings: [{ ...good.gradings[0], verdict: "mediocre" }],
      }),
    ).toThrow();
  });

  it("rejects a qualityScore out of range", () => {
    expect(() =>
      gradeBaselineSchema.parse({
        ...good,
        gradings: [{ ...good.gradings[0], qualityScore: 99 }],
      }),
    ).toThrow();
  });

  it("rejects duplicate questionIds", () => {
    expect(() =>
      gradeBaselineSchema.parse({
        ...good,
        gradings: [good.gradings[0], good.gradings[0]],
      }),
    ).toThrow(/duplicate/i);
  });
});
