import { describe, it, expect } from "vitest";
import { makeCloseTurnBaseSchema } from "./closeTurn";

const validPayload = {
  userMessage: "wrap-up text",
  gradings: [
    {
      kind: "free-text" as const,
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
    plannedConcepts: [],
  },
};

/** Shared empty-list params for tests that don't exercise the new fields. */
const baseParams = {
  scopeTiers: [1, 2, 3],
  questionIds: ["b1"],
  freshConceptNames: [],
  reviewDueNames: [],
  existingConceptNames: [],
} as const;

describe("makeCloseTurnBaseSchema", () => {
  it("accepts a valid payload", () => {
    const schema = makeCloseTurnBaseSchema(baseParams);
    expect(schema.parse(validPayload)).toMatchObject({ userMessage: "wrap-up text" });
  });

  it("rejects out-of-band qualityScore for verdict='correct'", () => {
    const schema = makeCloseTurnBaseSchema(baseParams);
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [{ ...validPayload.gradings[0], verdict: "correct", qualityScore: 1 }],
      }),
    ).toThrow(/qualityScore/);
  });

  it("rejects conceptTier outside scopeTiers", () => {
    const schema = makeCloseTurnBaseSchema({
      ...baseParams,
      scopeTiers: [1, 2],
    });
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [{ ...validPayload.gradings[0], conceptTier: 5 }],
      }),
    ).toThrow(/conceptTier/);
  });

  it("rejects gradings that don't cover every questionId", () => {
    const schema = makeCloseTurnBaseSchema({
      ...baseParams,
      questionIds: ["b1", "b2"],
    });
    expect(() => schema.parse(validPayload)).toThrow(/b2/);
  });

  it("rejects duplicate questionIds in gradings", () => {
    const schema = makeCloseTurnBaseSchema(baseParams);
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [validPayload.gradings[0], validPayload.gradings[0]],
      }),
    ).toThrow(/duplicate/);
  });
});

describe("makeCloseTurnBaseSchema — extended params", () => {
  const baseParams = {
    scopeTiers: [1, 2, 3],
    questionIds: ["q1"],
    freshConceptNames: ["Forces of supply and demand"],
    reviewDueNames: ["Price elasticity basics"],
    existingConceptNames: ["Forces of supply and demand", "Price elasticity basics"],
  };

  const minimalValidPayload = {
    userMessage: "ok",
    summary: "ok summary",
    gradings: [
      {
        kind: "free-text" as const,
        questionId: "q1",
        verdict: "correct" as const,
        qualityScore: 5,
        conceptName: "Forces of supply and demand",
        conceptTier: 1,
        rationale: "Right. Move on.",
      },
    ],
    nextUnitBlueprint: {
      topic: "T",
      outline: ["one"],
      openingText: "Welcome.",
      plannedConcepts: [
        { name: "Forces of supply and demand", tier: 2, role: "fresh" },
        { name: "Price elasticity basics", tier: 2, role: "review" },
      ],
    },
  };

  it("accepts a payload with plannedConcepts split between fresh and review", () => {
    const schema = makeCloseTurnBaseSchema(baseParams);
    expect(schema.safeParse(minimalValidPayload).success).toBe(true);
  });

  it("rejects review-role plannedConcept name not in reviewDueNames", () => {
    const schema = makeCloseTurnBaseSchema(baseParams);
    const bad = {
      ...minimalValidPayload,
      nextUnitBlueprint: {
        ...minimalValidPayload.nextUnitBlueprint,
        plannedConcepts: [{ name: "Nonexistent review", tier: 2, role: "review" as const }],
      },
    };
    const result = schema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain("Nonexistent review");
    }
  });

  it("permits fresh-role plannedConcept names not in freshConceptNames", () => {
    const schema = makeCloseTurnBaseSchema(baseParams);
    const novel = {
      ...minimalValidPayload,
      nextUnitBlueprint: {
        ...minimalValidPayload.nextUnitBlueprint,
        plannedConcepts: [{ name: "A novel concept", tier: 2, role: "fresh" as const }],
      },
    };
    expect(schema.safeParse(novel).success).toBe(true);
  });

  it("accepts mc-index grading (no qualityScore, no conceptTier)", () => {
    const schema = makeCloseTurnBaseSchema(baseParams);
    const mcOnly = {
      ...minimalValidPayload,
      gradings: [{ kind: "mc-index" as const, questionId: "q1", rationale: "Right click." }],
    };
    expect(schema.safeParse(mcOnly).success).toBe(true);
  });
});
