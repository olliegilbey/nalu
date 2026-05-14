import { describe, it, expect } from "vitest";
import { makeScopingCloseSchema, renderScopingCloseStage } from "./scopingClose";

const base = {
  userMessage: "wrap",
  gradings: [
    {
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
  },
};

describe("makeScopingCloseSchema", () => {
  it("accepts payload with immutableSummary and startingTier in scope", () => {
    const schema = makeScopingCloseSchema({ scopeTiers: [1, 2, 3], questionIds: ["b1"] });
    expect(
      schema.parse({ ...base, immutableSummary: "durable profile", startingTier: 2 }),
    ).toMatchObject({ startingTier: 2 });
  });

  it("rejects startingTier outside scopeTiers", () => {
    const schema = makeScopingCloseSchema({ scopeTiers: [1, 2], questionIds: ["b1"] });
    expect(() => schema.parse({ ...base, immutableSummary: "x", startingTier: 5 })).toThrow(
      /startingTier/,
    );
  });
});

describe("renderScopingCloseStage", () => {
  it("emits an XML envelope with the stage label and learner payload", () => {
    const out = renderScopingCloseStage({
      learnerInput: '{"items":[]}',
      responseSchema: undefined,
    });
    expect(out).toContain("<stage>close scoping</stage>");
    expect(out).toContain("<learner_input>");
  });
});
