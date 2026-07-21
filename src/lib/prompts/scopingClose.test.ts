import { describe, it, expect } from "vitest";
import { makeScopingCloseSchema, renderScopingCloseStage } from "./scopingClose";

/** Shared empty-list params for tests that don't exercise the new fields. */
const baseSchemaParams = {
  scopeTiers: [1, 2, 3],
  questionIds: ["b1"],
  freshConceptNames: [],
  reviewDueNames: [],
  existingConceptNames: [],
} as const;

const base = {
  userMessage: "wrap",
  gradings: [
    {
      kind: "free-text" as const,
      questionId: "b1",
      verdict: "correct" as const,
      qualityScore: 5,
      conceptName: "ownership",
      conceptTier: 2,
      rationale: "Solid answer. Start lesson 1 with moves.",
    },
  ],
  summary: "starting summary",
  nextUnitBlueprint: {
    topic: "Ownership basics",
    outline: ["a", "b"],
    openingText: "Welcome.",
    plannedConcepts: [],
  },
};

describe("makeScopingCloseSchema", () => {
  it("accepts payload with immutableSummary and startingTier in scope", () => {
    const schema = makeScopingCloseSchema(baseSchemaParams);
    expect(
      schema.parse({ ...base, immutableSummary: "durable profile", startingTier: 2 }),
    ).toMatchObject({ startingTier: 2 });
  });

  it("rejects startingTier outside scopeTiers", () => {
    const schema = makeScopingCloseSchema({ ...baseSchemaParams, scopeTiers: [1, 2] });
    expect(() => schema.parse({ ...base, immutableSummary: "x", startingTier: 5 })).toThrow(
      /startingTier/,
    );
  });
});

describe("renderScopingCloseStage", () => {
  it("emits an XML envelope with the stage label and learner payload", () => {
    const out = renderScopingCloseStage({
      learnerInput: '{"items":[]}',
    });
    expect(out).toContain("<stage>close scoping</stage>");
    expect(out).toContain("<learner_input>");
  });
});
