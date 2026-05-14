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

  it("validates a baseline payload with gradings (camelCase)", () => {
    expect(
      baselineJsonbSchema.parse({
        userMessage: "Here is your baseline assessment.",
        questions: [],
        responses: [],
        gradings: [
          {
            questionId: "b1",
            conceptName: "x",
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
      baselineJsonbSchema.parse({
        userMessage: "Here is your baseline assessment.",
        questions: [],
        responses: [],
        gradings: [
          {
            questionId: "b1",
            conceptName: "x",
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
      baselineJsonbSchema.parse({
        userMessage: "Here is your baseline assessment.",
        questions: [],
        responses: [],
        gradings: [
          {
            questionId: "b1",
            conceptName: "x",
            verdict: "correct", // band [4, 5]
            qualityScore: 1, // mismatch
            rationale: "ok",
          },
        ],
      }),
    ).toThrow();
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
