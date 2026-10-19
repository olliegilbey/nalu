import { describe, it, expect } from "vitest";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
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

  it("strips fabricated gradings when no questionnaire was answered", () => {
    // A chat-text close turn has no open questionnaire, so questionIds is
    // empty and zero legitimate gradings exist — any entry is the model
    // re-grading questions from earlier in the wave. The prior approach
    // (reject + teacher-style retry directive) was only probabilistically
    // obeyed (live-smoke wave-close flaked repeatedly, 2026-07-14), so the
    // schema now strips deterministically: no XP can flow from a turn with
    // no answered questions.
    const schema = makeCloseTurnBaseSchema({ ...baseParams, questionIds: [] });
    const result = schema.parse(validPayload);
    expect(result.gradings).toEqual([]);
    // Non-grading fields survive untouched.
    expect(result.userMessage).toBe(validPayload.userMessage);
  });

  it("still accepts an honest empty gradings array when no questionnaire was answered", () => {
    const schema = makeCloseTurnBaseSchema({ ...baseParams, questionIds: [] });
    const result = schema.parse({ ...validPayload, gradings: [] });
    expect(result.gradings).toEqual([]);
  });

  it("rejects gradings containing an unknown questionId", () => {
    // questionIds = ["b1"]; payload covers b1 but also fabricates a phantom id.
    // All expected ids are present, so the missing-id check passes — the
    // unknown-id check must still reject the phantom.
    const schema = makeCloseTurnBaseSchema(baseParams);
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [
          validPayload.gradings[0],
          { ...validPayload.gradings[0], questionId: "phantom" },
        ],
      }),
    ).toThrow(/phantom/);
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

// The model reads the role description and the refine message. It never sees
// the `reviewDueNames` param; it sees the due list as `<review_due>`, and the
// scoping close shows no due list at all (issue #151).
describe("makeCloseTurnBaseSchema — review-role wording the model reads", () => {
  /** Payload planning one review-role concept; the due list varies per test. */
  const reviewPlan = {
    ...validPayload,
    nextUnitBlueprint: {
      ...validPayload.nextUnitBlueprint,
      plannedConcepts: [{ name: "borrowing_rules", tier: 1, role: "review" as const }],
    },
  };

  it("names <review_due> in the wire role description, not the code param", () => {
    const wire = toSchemaJsonString(makeCloseTurnBaseSchema(baseParams), { name: "close_turn" });
    expect(wire).toContain("<review_due>");
    expect(wire).not.toContain("reviewDueNames");
  });

  it("directs the model to 'fresh' when nothing is due yet", () => {
    // Scoping close: the due list is always empty.
    const result = makeCloseTurnBaseSchema(baseParams).safeParse(reviewPlan);
    expect(result.success).toBe(false);
    const message = result.error?.issues[0]?.message ?? "";
    expect(message).toContain("borrowing_rules");
    expect(message).toContain("nothing is due");
    expect(message).toContain("'fresh'");
    expect(message).not.toContain("reviewDueNames");
  });

  it("names the review_due list when the concept is not on it", () => {
    const result = makeCloseTurnBaseSchema({
      ...baseParams,
      reviewDueNames: ["Price elasticity basics"],
    }).safeParse(reviewPlan);
    expect(result.success).toBe(false);
    const message = result.error?.issues[0]?.message ?? "";
    expect(message).toContain("review_due");
    expect(message).toContain("Price elasticity basics");
    expect(message).toContain("'fresh'");
    expect(message).not.toContain("reviewDueNames");
    // buildRetryDirective escapes messages, so a literal tag would reach the model as &lt;…&gt;.
    expect(message).not.toMatch(/[<>]/);
  });
});
