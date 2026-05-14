import { describe, it, expect } from "vitest";
import { makeCloseTurnBaseSchema } from "./closeTurn";

const validPayload = {
  userMessage: "wrap-up text",
  gradings: [
    {
      questionId: "b1",
      verdict: "correct" as const,
      qualityScore: 5,
      conceptName: "ownership",
      conceptTier: 2,
      rationale: "Two-sentence rationale. Tells us where to start.",
    },
  ],
  summary: "Initial summary of where they're starting.",
  nextUnitBlueprint: {
    topic: "Ownership basics",
    outline: ["intro", "moves", "borrows"],
    openingText: "Welcome. We'll start with how Rust tracks ownership.",
  },
};

describe("makeCloseTurnBaseSchema", () => {
  it("accepts a valid payload", () => {
    const schema = makeCloseTurnBaseSchema({ scopeTiers: [1, 2, 3], questionIds: ["b1"] });
    expect(schema.parse(validPayload)).toMatchObject({ userMessage: "wrap-up text" });
  });

  it("rejects out-of-band qualityScore for verdict='correct'", () => {
    const schema = makeCloseTurnBaseSchema({ scopeTiers: [1, 2, 3], questionIds: ["b1"] });
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [{ ...validPayload.gradings[0], verdict: "correct", qualityScore: 1 }],
      }),
    ).toThrow(/qualityScore/);
  });

  it("rejects conceptTier outside scopeTiers", () => {
    const schema = makeCloseTurnBaseSchema({ scopeTiers: [1, 2], questionIds: ["b1"] });
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [{ ...validPayload.gradings[0], conceptTier: 5 }],
      }),
    ).toThrow(/conceptTier/);
  });

  it("rejects gradings that don't cover every questionId", () => {
    const schema = makeCloseTurnBaseSchema({
      scopeTiers: [1, 2, 3],
      questionIds: ["b1", "b2"],
    });
    expect(() => schema.parse(validPayload)).toThrow(/b2/);
  });

  it("rejects duplicate questionIds in gradings", () => {
    const schema = makeCloseTurnBaseSchema({ scopeTiers: [1, 2, 3], questionIds: ["b1"] });
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [validPayload.gradings[0], validPayload.gradings[0]],
      }),
    ).toThrow(/duplicate/);
  });
});
