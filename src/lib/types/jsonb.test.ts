import { describe, it, expect } from "vitest";
import {
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
  dueConceptsSnapshotSchema,
  seedSourceSchema,
  blueprintSchema,
} from "./jsonb";

describe("jsonb trust-boundary schemas", () => {
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
