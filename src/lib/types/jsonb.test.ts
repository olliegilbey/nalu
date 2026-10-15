import { describe, it, expect } from "vitest";
import {
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
  baselineQuestionsJsonbSchema,
  baselineClosedJsonbSchema,
  dueConceptsSnapshotSchema,
  seedSourceSchema,
  blueprintSchema,
} from "./jsonb";

describe("jsonb trust-boundary schemas", () => {
  // ---------------------------------------------------------------------------
  // clarificationJsonbSchema — camelCase wire shape
  // ---------------------------------------------------------------------------

  it("validates a clarification payload with a free_text question", () => {
    expect(
      clarificationJsonbSchema.parse({
        userMessage: "Let me ask you a few questions.",
        questions: [
          {
            id: "q1",
            type: "free_text",
            prompt: "What's your goal?",
            freetextRubric: "Explain clearly.",
          },
        ],
        responses: [],
      }),
    ).toBeDefined();
  });

  it("validates a clarification payload with a multiple_choice question", () => {
    expect(
      clarificationJsonbSchema.parse({
        userMessage: "Here are your questions.",
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "Pick one",
            options: { A: "Beginner", B: "Intermediate", C: "Advanced", D: "Expert" },
            freetextRubric: "Explain your choice.",
            correct: "A",
          },
        ],
        responses: [],
      }),
    ).toBeDefined();
  });

  it("validates a clarification response (freetext)", () => {
    expect(
      clarificationJsonbSchema.parse({
        userMessage: "Here are your questions.",
        questions: [
          {
            id: "q1",
            type: "free_text",
            prompt: "x",
            freetextRubric: "r",
          },
        ],
        responses: [{ questionId: "q1", freetext: "my answer" }],
      }),
    ).toBeDefined();
  });

  it("rejects a clarification response with both choice and freetext", () => {
    expect(() =>
      clarificationJsonbSchema.parse({
        userMessage: "Here are your questions.",
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "x",
            options: { A: "a", B: "b", C: "c", D: "d" },
            freetextRubric: "r",
          },
        ],
        responses: [{ questionId: "q1", choice: "A", freetext: "my answer" }],
      }),
    ).toThrow();
  });

  it("validates a framework payload with tiers (camelCase)", () => {
    expect(
      frameworkJsonbSchema.parse({
        userMessage: "Here's the framework.",
        estimatedStartingTier: 2,
        baselineScopeTiers: [1, 2],
        tiers: [
          {
            number: 1,
            name: "Basics",
            description: "Intro",
            exampleConcepts: ["T", "U"],
          },
          {
            number: 2,
            name: "Advanced",
            description: "Constraints",
            exampleConcepts: ["extends"],
          },
        ],
      }),
    ).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // baselineQuestionsJsonbSchema — pre-close shape (after generateBaseline)
  // ---------------------------------------------------------------------------

  it("validates a pre-close baseline payload (questions/responses/gradings only)", () => {
    expect(
      baselineQuestionsJsonbSchema.parse({
        userMessage: "Here is your baseline assessment.",
        questions: [],
        responses: [],
        gradings: [
          {
            questionId: "b1",
            conceptName: "x",
            conceptTier: 1,
            verdict: "correct",
            qualityScore: 4,
            rationale: "ok",
          },
        ],
      }),
    ).toBeDefined();
  });

  it("rejects a baseline grading with unknown verdict", () => {
    expect(() =>
      baselineQuestionsJsonbSchema.parse({
        userMessage: "Here is your baseline assessment.",
        questions: [],
        responses: [],
        gradings: [
          {
            questionId: "b1",
            conceptName: "x",
            conceptTier: 1,
            verdict: "maybe",
            qualityScore: 4,
            rationale: "ok",
          },
        ],
      }),
    ).toThrow();
  });

  // Defence-in-depth: persistence layer also rejects band/verdict mismatches —
  // not just the LLM-facing prompt schema. Guards against bad data smuggled in
  // via manual DB writes or future schema drift.
  it("rejects a baseline grading when verdict and qualityScore bands disagree", () => {
    expect(() =>
      baselineQuestionsJsonbSchema.parse({
        userMessage: "Here is your baseline assessment.",
        questions: [],
        responses: [],
        gradings: [
          {
            questionId: "b1",
            conceptName: "x",
            conceptTier: 1,
            verdict: "correct", // band [4, 5]
            qualityScore: 1, // mismatch
            rationale: "ok",
          },
        ],
      }),
    ).toThrow();
  });

  // ---------------------------------------------------------------------------
  // baselineClosedJsonbSchema — close-turn shape (after submitBaseline)
  // ---------------------------------------------------------------------------

  it("accepts the closing payload with summaries, startingTier, and per-grading conceptTier", () => {
    const parsed = baselineClosedJsonbSchema.parse({
      userMessage: "wrap-up",
      questions: [
        {
          id: "b1",
          type: "multiple_choice",
          prompt: "Q",
          options: { A: "a", B: "b", C: "c", D: "d" },
          freetextRubric: "rubric",
          conceptName: "ownership",
          tier: 2,
        },
      ],
      responses: [{ questionId: "b1", choice: "A" }],
      gradings: [
        {
          questionId: "b1",
          conceptName: "ownership",
          conceptTier: 2,
          verdict: "correct",
          qualityScore: 5,
          rationale: "fine",
        },
      ],
      immutableSummary: "durable profile",
      summarySeed: "evolving summary v0",
      startingTier: 2,
    });
    expect(parsed.startingTier).toBe(2);
    expect(parsed.gradings[0]?.conceptTier).toBe(2);
  });

  it("rejects verdict/qualityScore mismatch on the closed shape", () => {
    expect(() =>
      baselineClosedJsonbSchema.parse({
        userMessage: "x",
        questions: [],
        responses: [],
        gradings: [
          {
            questionId: "b1",
            conceptName: "c",
            conceptTier: 1,
            verdict: "correct",
            qualityScore: 1,
            rationale: "r",
          },
        ],
        immutableSummary: "s",
        summarySeed: "s",
        startingTier: 1,
      }),
    ).toThrow(/qualityScore/);
  });

  // ---------------------------------------------------------------------------
  // baselineJsonbSchema (union) — accepts either shape
  // ---------------------------------------------------------------------------

  it("parses both pre-close and closed payloads via the union", () => {
    const preClose = baselineJsonbSchema.parse({
      userMessage: "u",
      questions: [],
      responses: [],
      gradings: [],
    });
    expect(preClose).toBeDefined();

    const closed = baselineJsonbSchema.parse({
      userMessage: "u",
      questions: [],
      responses: [],
      gradings: [],
      immutableSummary: "s",
      summarySeed: "s",
      startingTier: 1,
    });
    expect(closed).toBeDefined();
  });

  // Regression guard for the silent-degradation hazard: without `.strict()` on
  // the pre-close arm, a half-written close payload (missing `summarySeed`)
  // would fail the closed arm and then fall through to the pre-close arm,
  // which would happily strip the unknown close-turn fields and look healthy.
  it("rejects a malformed close payload (immutableSummary without summarySeed) through the union", () => {
    expect(() =>
      baselineJsonbSchema.parse({
        userMessage: "x",
        questions: [],
        responses: [],
        gradings: [],
        immutableSummary: "durable",
        // summarySeed missing
        startingTier: 1,
      }),
    ).toThrow(); // strict mode on the questions arm makes immutableSummary/startingTier unknown keys
  });

  // Parallel guard: a well-formed closed payload must surface its close-turn
  // fields through the union — the discrimination cannot silently degrade.
  it("preserves close-turn fields when a closed payload parses through the union (no silent strip)", () => {
    const parsed = baselineJsonbSchema.parse({
      userMessage: "x",
      questions: [],
      responses: [],
      gradings: [],
      immutableSummary: "durable",
      summarySeed: "v0",
      startingTier: 3,
    });
    expect("startingTier" in parsed).toBe(true);
    if ("startingTier" in parsed) {
      expect(parsed.startingTier).toBe(3);
      expect(parsed.summarySeed).toBe("v0");
    }
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

  // ---------------------------------------------------------------------------
  // seedSourceSchema — discriminated union with blueprint on scoping_handoff
  // ---------------------------------------------------------------------------

  it("requires a blueprint on scoping_handoff seed_source", () => {
    const ok = seedSourceSchema.parse({
      kind: "scoping_handoff",
      blueprint: { topic: "t", outline: ["a"], openingText: "hi" },
    });
    expect(ok.kind).toBe("scoping_handoff");
    expect(() => seedSourceSchema.parse({ kind: "scoping_handoff" })).toThrow();
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
