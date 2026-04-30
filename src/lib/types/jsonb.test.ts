import { describe, it, expect } from "vitest";
import {
  clarificationQuestionSchema,
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
  dueConceptsSnapshotSchema,
  seedSourceSchema,
  blueprintSchema,
} from "./jsonb";

describe("jsonb trust-boundary schemas", () => {
  // ---------------------------------------------------------------------------
  // clarificationQuestionSchema — discriminated union tightness
  // ---------------------------------------------------------------------------

  describe("clarificationQuestionSchema discriminated union", () => {
    it("accepts well-formed free_text question", () => {
      // free_text with no options is the canonical shape.
      expect(
        clarificationQuestionSchema.parse({
          id: "q1",
          text: "What's your goal?",
          type: "free_text",
        }),
      ).toBeDefined();
    });

    it("accepts well-formed single_select question with ≥2 options", () => {
      // single_select must have at least 2 options for a meaningful radio group.
      expect(
        clarificationQuestionSchema.parse({
          id: "q2",
          text: "Pick one",
          type: "single_select",
          options: ["Beginner", "Intermediate"],
        }),
      ).toBeDefined();
    });

    it("rejects free_text question with an options field", () => {
      // free_text branch uses `.strict()` so unrecognised keys (including an
      // accidental `options` array) cause a ZodError instead of silent stripping.
      // This prevents the LLM from smuggling display options into a free_text
      // question and having them silently ignored at the parse boundary.
      expect(() =>
        clarificationQuestionSchema.parse({
          id: "q1",
          text: "x",
          type: "free_text",
          options: ["a", "b"],
        }),
      ).toThrow();
    });

    it("rejects single_select question without options", () => {
      // single_select with no options makes no sense as a radio group.
      expect(() =>
        clarificationQuestionSchema.parse({ id: "q3", text: "Pick one", type: "single_select" }),
      ).toThrow();
    });

    it("rejects single_select with only 1 option", () => {
      // min(2) enforced — a single-option radio group cannot represent a choice.
      expect(() =>
        clarificationQuestionSchema.parse({
          id: "q4",
          text: "Pick one",
          type: "single_select",
          options: ["Only option"],
        }),
      ).toThrow();
    });
  });

  it("validates a clarification payload", () => {
    expect(
      clarificationJsonbSchema.parse({
        questions: [{ id: "q1", text: "x", type: "free_text" }],
        answers: [{ questionId: "q1", answer: "y" }],
      }),
    ).toBeDefined();
  });

  it("validates a framework payload with tiers", () => {
    expect(
      frameworkJsonbSchema.parse({
        topic: "Rust ownership",
        scope_summary: "test",
        estimated_starting_tier: 2,
        baseline_scope_tiers: [1, 2, 3],
        tiers: [{ number: 1, name: "Mental Model", description: "x", example_concepts: ["a"] }],
      }),
    ).toBeDefined();
  });

  it("validates a baseline payload with gradings", () => {
    expect(
      baselineJsonbSchema.parse({
        questions: [],
        answers: [],
        gradings: [
          {
            question_id: "b1",
            concept_name: "x",
            quality_score: 3,
            is_correct: true,
            rationale: "ok",
          },
        ],
      }),
    ).toBeDefined();
  });

  it("validates a due-concepts snapshot", () => {
    expect(
      dueConceptsSnapshotSchema.parse([
        {
          conceptId: "a0000000-0000-4000-8000-000000000001",
          name: "x",
          tier: 1,
          lastQuality: null,
        },
      ]),
    ).toHaveLength(1);
  });

  it("validates a scoping_handoff seed_source", () => {
    expect(seedSourceSchema.parse({ kind: "scoping_handoff" })).toMatchObject({
      kind: "scoping_handoff",
    });
  });

  it("validates a prior_blueprint seed_source", () => {
    expect(
      seedSourceSchema.parse({
        kind: "prior_blueprint",
        priorWaveId: "a0000000-0000-4000-8000-000000000002",
        blueprint: { topic: "x", outline: ["a", "b"], openingText: "hi" },
      }),
    ).toBeDefined();
  });

  it("rejects unknown seed_source kinds", () => {
    expect(() => seedSourceSchema.parse({ kind: "bogus" })).toThrow();
  });

  it("validates a bare blueprint", () => {
    expect(blueprintSchema.parse({ topic: "x", outline: [], openingText: "" })).toBeDefined();
  });
});
