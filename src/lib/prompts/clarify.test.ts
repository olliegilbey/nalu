import { describe, expect, it } from "vitest";
import { clarifySchema } from "./clarify";
import { UNGRADED_RUBRIC } from "./questionnaire";
import { SCOPING } from "@/lib/config/tuning";
import { toCerebrasJsonSchema } from "@/lib/llm/toCerebrasJsonSchema";

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

  // Clarify deliberately tolerates stray `conceptName`/`tier` — see the note in
  // `clarify.ts`. Schema description + system prompt instruct the model to omit
  // them; weak models occasionally slip and we accept rather than fail the turn.
  it("accepts clarify questions even if the model emits stray conceptName/tier", () => {
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
              conceptName: "model slipped",
              tier: 1,
            },
            { id: "q2", type: "free_text", prompt: "p2", freetextRubric: "r" },
          ],
        },
      }),
    ).not.toThrow();
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

  // Issue #22: the placeholder guidance lives on clarify's own description,
  // not the shared question schema, so graded stages never see it.
  it("tells the model to write the ungraded placeholder rubric", () => {
    const wire = JSON.stringify(toCerebrasJsonSchema(clarifySchema, { name: "clarify" }).schema);
    expect(wire).toContain(UNGRADED_RUBRIC);
  });

  // Clarify is elicitation, so its placeholder rubric is legal here.
  it("accepts the placeholder rubric on clarify questions", () => {
    const q = (id: string) => ({
      id,
      type: "free_text" as const,
      prompt: "p",
      freetextRubric: UNGRADED_RUBRIC,
    });
    expect(() =>
      clarifySchema.parse({ userMessage: "hi", questions: { questions: [q("q1"), q("q2")] } }),
    ).not.toThrow();
  });
});
