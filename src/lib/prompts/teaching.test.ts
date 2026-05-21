import { describe, expect, it } from "vitest";
import { renderTeachingSystem } from "./teaching";
import type { WaveSeedInputs } from "@/lib/types/context";

const baseInputs: WaveSeedInputs = {
  kind: "wave",
  courseTopic: "Economics",
  topicScope: "Supply, demand, elasticity.",
  framework: {
    userMessage: "ok",
    tiers: [
      { number: 1, name: "Foundations", description: "...", exampleConcepts: ["Markets"] },
      { number: 2, name: "Mid", description: "...", exampleConcepts: ["Elasticity"] },
    ],
    estimatedStartingTier: 2,
    baselineScopeTiers: [1, 2],
  },
  currentTier: 2,
  customInstructions: null,
  courseSummary: "Learner is comfortable with foundations.",
  dueConcepts: [],
  seedSource: {
    kind: "scoping_handoff",
    blueprint: {
      topic: "Demand basics",
      outline: ["Why demand slopes down"],
      openingText: "Hi.",
      plannedConcepts: [
        { name: "Demand curve shape", tier: 2, role: "fresh" },
        { name: "Substitution effect", tier: 2, role: "review" },
      ],
    },
  },
};

describe("renderTeachingSystem (JSON-everywhere)", () => {
  it("does NOT instruct the model to emit <response>/<assessment>/<comprehension_signal> tags", () => {
    const out = renderTeachingSystem(baseInputs);
    expect(out).not.toMatch(/<response>\.\.\./);
    expect(out).not.toMatch(/<assessment>/);
    expect(out).not.toMatch(/<comprehension_signal>/);
  });

  it("declares the single-JSON output contract", () => {
    const out = renderTeachingSystem(baseInputs);
    expect(out).toContain("single JSON object");
  });

  it("renders <planned_concepts> from blueprint.plannedConcepts", () => {
    const out = renderTeachingSystem(baseInputs);
    expect(out).toContain("<planned_concepts>");
    expect(out).toContain("Demand curve shape");
    expect(out).toContain("fresh");
    expect(out).toContain("Substitution effect");
    expect(out).toContain("review");
  });

  it("omits <planned_concepts> when blueprint has none", () => {
    const inputs = {
      ...baseInputs,
      seedSource: {
        ...baseInputs.seedSource,
        blueprint: { ...baseInputs.seedSource.blueprint, plannedConcepts: [] },
      },
    } as WaveSeedInputs;
    const out = renderTeachingSystem(inputs);
    expect(out).not.toContain("<planned_concepts>");
  });
});
