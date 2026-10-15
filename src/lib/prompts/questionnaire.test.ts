import { describe, expect, it } from "vitest";
import {
  questionSchema,
  questionnaireSchema,
  responseSchema,
  responsesSchema,
  UNGRADED_RUBRIC,
  isPlaceholderRubric,
} from "./questionnaire";
import { toCerebrasJsonSchema } from "@/lib/llm/toCerebrasJsonSchema";
import { QUESTIONNAIRE } from "@/lib/config/tuning";

// Issue #22: the shared rubric description once offered clarify's
// "no grading — informational" as an example. The model copied it onto
// graded baseline questions, so the grader had no answer key.
describe("isPlaceholderRubric", () => {
  it("flags the clarify placeholder and its near-copies", () => {
    expect(isPlaceholderRubric(UNGRADED_RUBRIC)).toBe(true);
    expect(isPlaceholderRubric("No grading - informational.")).toBe(true);
    expect(isPlaceholderRubric("No-grading, informational")).toBe(true);
  });

  it("flags a rubric shorter than QUESTIONNAIRE.rubricMinChars", () => {
    expect(isPlaceholderRubric("n/a")).toBe(true);
    expect(isPlaceholderRubric("x".repeat(QUESTIONNAIRE.rubricMinChars - 1))).toBe(true);
    // Padding does not count: the floor is on the trimmed text.
    expect(isPlaceholderRubric(`  ${"x".repeat(QUESTIONNAIRE.rubricMinChars - 1)}  `)).toBe(true);
  });

  it("accepts a rubric that states what a correct answer contains", () => {
    expect(isPlaceholderRubric("x".repeat(QUESTIONNAIRE.rubricMinChars))).toBe(false);
    expect(
      isPlaceholderRubric("Says a move transfers ownership and invalidates the source binding."),
    ).toBe(false);
  });

  // Only a rubric that OPENS with "no grading" is the placeholder. Real
  // rubrics on piano exams or colour grading use the words mid-sentence.
  it("accepts real rubrics that say 'grading' or 'no grading' mid-sentence", () => {
    expect(isPlaceholderRubric("Explains that ABRSM piano grading runs from Grade 1 to 8.")).toBe(
      false,
    );
    expect(isPlaceholderRubric("Says that with no grading applied, log footage looks flat.")).toBe(
      false,
    );
  });
});

describe("free-text rubric description", () => {
  it("is neutral, and carries no clarify placeholder", () => {
    // Clarify and baseline both send this description. Each stage's own
    // description says what its rubric must be.
    const wire = JSON.stringify(toCerebrasJsonSchema(questionSchema, { name: "question" }).schema);
    expect(wire).not.toContain(UNGRADED_RUBRIC);
    expect(wire).toContain("How to grade a free-text response. Never shown to the learner.");
  });
});

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

  it("rejects duplicate question ids within one questionnaire (bug_004 intra-questionnaire)", () => {
    // Two questions sharing `q1` would map to two assessment rows with an
    // identical `(wave_id, question_id)` even after namespacing — namespacing
    // only disambiguates ACROSS questionnaires. This superRefine catches it at
    // parse time so executeTurn can retry rather than 500 on the unique index.
    expect(() =>
      questionnaireSchema.parse({
        questions: [
          { id: "q1", type: "free_text", prompt: "first", freetextRubric: "r" },
          { id: "q1", type: "free_text", prompt: "second", freetextRubric: "r" },
        ],
      }),
    ).toThrow(/duplicate question ids/i);
  });

  it("accepts a multi-question questionnaire with distinct ids", () => {
    expect(() =>
      questionnaireSchema.parse({
        questions: [
          { id: "q1", type: "free_text", prompt: "first", freetextRubric: "r" },
          { id: "q2", type: "free_text", prompt: "second", freetextRubric: "r" },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts a responses wrapper", () => {
    expect(() =>
      responsesSchema.parse({ responses: [{ questionId: "q1", choice: "A" }] }),
    ).not.toThrow();
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
