import { describe, expect, it } from "vitest";
import { clarifySchema } from "./clarify";
import { SCOPING } from "@/lib/config/tuning";

describe("clarifySchema", () => {
  it("accepts a userMessage plus 2 questions", () => {
    expect(() =>
      clarifySchema.parse({
        userMessage: "Let's nail down a few things.",
        questions: {
          questions: [
            { id: "q1", type: "free_text", prompt: "What's your goal?", freetextRubric: "n/a" },
            { id: "q2", type: "free_text", prompt: "Prior background?", freetextRubric: "n/a" },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("rejects fewer than the minimum clarify questions", () => {
    expect(() =>
      clarifySchema.parse({
        userMessage: "hi",
        questions: {
          questions: [{ id: "q1", type: "free_text", prompt: "p", freetextRubric: "r" }],
        },
      }),
    ).toThrow(/clarify questions must be between/i);
  });

  it("rejects more than the maximum clarify questions", () => {
    const make = (i: number) => ({
      id: `q${i}`,
      type: "free_text" as const,
      prompt: "p",
      freetextRubric: "r",
    });
    const overshoot = Array.from({ length: SCOPING.maxClarifyAnswers + 1 }, (_, i) => make(i + 1));
    expect(() =>
      clarifySchema.parse({ userMessage: "hi", questions: { questions: overshoot } }),
    ).toThrow(/clarify questions must be between/i);
  });

  it("rejects clarify questions carrying conceptName or tier", () => {
    expect(() =>
      clarifySchema.parse({
        userMessage: "hi",
        questions: {
          questions: [
            {
              id: "q1",
              type: "free_text",
              prompt: "p",
              freetextRubric: "r",
              conceptName: "should not be here",
              tier: 1,
            },
            { id: "q2", type: "free_text", prompt: "p2", freetextRubric: "r" },
          ],
        },
      }),
    ).toThrow(/clarify questions must not carry conceptName or tier/i);
  });

  it("accepts exactly the maximum clarify questions", () => {
    const make = (i: number) => ({
      id: `q${i}`,
      type: "free_text" as const,
      prompt: "p",
      freetextRubric: "r",
    });
    const max = Array.from({ length: SCOPING.maxClarifyAnswers }, (_, i) => make(i + 1));
    expect(() =>
      clarifySchema.parse({ userMessage: "hi", questions: { questions: max } }),
    ).not.toThrow();
  });
});
