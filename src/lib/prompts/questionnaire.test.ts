import { describe, expect, it } from "vitest";
import {
  questionSchema,
  questionnaireSchema,
  responseSchema,
  responsesSchema,
  MC_OPTION_KEYS,
} from "./questionnaire";
import { toCerebrasJsonSchema } from "@/lib/llm/toCerebrasJsonSchema";

describe("questionSchema", () => {
  it("accepts a minimal free_text question", () => {
    expect(() =>
      questionSchema.parse({
        id: "q1",
        type: "free_text",
        prompt: "Why?",
        freetextRubric: "any answer is fine",
      }),
    ).not.toThrow();
  });

  it("accepts a multiple_choice question with all four options", () => {
    expect(() =>
      questionSchema.parse({
        id: "q2",
        type: "multiple_choice",
        prompt: "Pick one.",
        options: { A: "a", B: "b", C: "c", D: "d" },
        correct: "C",
        freetextRubric: "rubric",
      }),
    ).not.toThrow();
  });

  it("rejects an MC question missing an option", () => {
    expect(() =>
      questionSchema.parse({
        id: "q2",
        type: "multiple_choice",
        prompt: "Pick one.",
        // Missing D.
        options: { A: "a", B: "b", C: "c" },
        correct: "A",
        freetextRubric: "rubric",
      }),
    ).toThrow();
  });

  it("rejects an unknown discriminator type", () => {
    expect(() =>
      questionSchema.parse({
        id: "q3",
        type: "single_select",
        prompt: "old",
      }),
    ).toThrow();
  });
});

describe("responseSchema", () => {
  it("accepts a choice-only response", () => {
    expect(() => responseSchema.parse({ questionId: "q1", choice: "A" })).not.toThrow();
  });

  it("accepts a freetext-only response", () => {
    expect(() => responseSchema.parse({ questionId: "q1", freetext: "hi" })).not.toThrow();
  });

  it("rejects a response with both choice and freetext", () => {
    expect(() => responseSchema.parse({ questionId: "q1", choice: "A", freetext: "hi" })).toThrow(
      /exactly one/i,
    );
  });

  it("rejects a response with neither choice nor freetext", () => {
    expect(() => responseSchema.parse({ questionId: "q1" })).toThrow(/exactly one/i);
  });

  it("rejects a response with an empty-string freetext (treated as not-set)", () => {
    // Empty string is a blank field — same as omitting freetext entirely.
    expect(() => responseSchema.parse({ questionId: "q1", freetext: "" })).toThrow(/exactly one/i);
  });
});

describe("questionnaireSchema + responsesSchema", () => {
  it("accepts a non-empty questionnaire", () => {
    expect(() =>
      questionnaireSchema.parse({
        questions: [{ id: "q1", type: "free_text", prompt: "p", freetextRubric: "r" }],
      }),
    ).not.toThrow();
  });

  it("rejects an empty questionnaire (refine: at least one question)", () => {
    expect(() => questionnaireSchema.parse({ questions: [] })).toThrow();
  });

  it("accepts a responses wrapper", () => {
    expect(() =>
      responsesSchema.parse({ responses: [{ questionId: "q1", choice: "A" }] }),
    ).not.toThrow();
  });
});

describe("MC_OPTION_KEYS", () => {
  it("is the canonical A/B/C/D tuple", () => {
    expect(MC_OPTION_KEYS).toEqual(["A", "B", "C", "D"]);
  });
});

describe("visibility tags survive toCerebrasJsonSchema", () => {
  it("serialised schema retains [server] and [UI] annotations", () => {
    // Regression guard: .describe() calls on questionSchema fields are the
    // model's guide on the wire. Stripping them would silently break structured
    // output quality. This test catches anyone removing them "as dead docs".
    const result = toCerebrasJsonSchema(questionSchema, { name: "question" });
    const wire = JSON.stringify(result.schema);
    expect(wire).toMatch(/\[server\]/);
    expect(wire).toMatch(/\[UI\]/);
  });
});
