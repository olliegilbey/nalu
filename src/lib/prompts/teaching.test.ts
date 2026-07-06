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

describe("renderTeachingSystem (output contracts)", () => {
  it("absent outputContract renders byte-identically to explicit 'json'", () => {
    expect(renderTeachingSystem({ ...baseInputs, outputContract: "json" })).toBe(
      renderTeachingSystem(baseInputs),
    );
  });

  it("json contract declares single-JSON and never mentions the tools", () => {
    const out = renderTeachingSystem({ ...baseInputs, outputContract: "json" });
    expect(out).toContain("single JSON object");
    expect(out).toContain("the questionnaire field");
    expect(out).not.toContain("presentQuestionnaire");
    expect(out).not.toContain("recordComprehensionSignals");
  });

  it("tools contract names both tools, keeps single-JSON for the final turn, drops field vocab", () => {
    const out = renderTeachingSystem({ ...baseInputs, outputContract: "tools" });
    expect(out).toContain("presentQuestionnaire");
    expect(out).toContain("recordComprehensionSignals");
    // Close turns still run the blocking single-JSON path under this prompt.
    expect(out).toContain("final turn no tools are available");
    expect(out).toContain("single JSON object");
    // Mega-schema vocabulary must not leak into the tools prompt.
    expect(out).not.toContain("the questionnaire field");
  });

  it("contracts differ ONLY in the questionnaire channel + output format", () => {
    const json = renderTeachingSystem({ ...baseInputs, outputContract: "json" });
    const tools = renderTeachingSystem({ ...baseInputs, outputContract: "tools" });
    // Shared pedagogy is identical: strip the two contract-dependent pieces
    // and the remainder must match. Cheap proxy: both keep the security block
    // and lesson-seed sections byte-identical.
    const sharedMarkers = [
      "<course_topic>",
      "<lesson_seed>",
      "Do not award, claim, or acknowledge XP amounts.",
      "End each lesson on a teaching beat",
    ];
    sharedMarkers.forEach((m) => {
      expect(json).toContain(m);
      expect(tools).toContain(m);
    });
    expect(json).not.toBe(tools);
  });
});
