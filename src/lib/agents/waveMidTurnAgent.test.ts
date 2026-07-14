import { describe, it, expect, vi } from "vitest";
import type { WaveSeedInputs } from "@/lib/types/context";
import { renderTeachingSystem } from "@/lib/prompts/teaching";
import { buildWaveMidTurnAgent } from "./waveMidTurnAgent";

// The provider needs env at import time — stub it; these tests never call.
vi.mock("@/lib/llm/provider", () => ({
  getLlmModel: () => ({ modelId: "stub", specificationVersion: "v3" }),
}));

const SEED: WaveSeedInputs = {
  kind: "wave",
  courseTopic: "Rust",
  topicScope: "Ownership",
  framework: {
    userMessage: "fw",
    estimatedStartingTier: 1,
    baselineScopeTiers: [1],
    tiers: [{ number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] }],
  },
  currentTier: 1,
  customInstructions: null,
  courseSummary: "seed",
  seedSource: {
    kind: "scoping_handoff",
    blueprint: { topic: "Ownership", outline: ["x"], openingText: "hi", plannedConcepts: [] },
  },
  dueConcepts: [],
  outputContract: "tools",
};

const COURSE_ID = "11111111-1111-4111-8111-111111111111";

describe("buildWaveMidTurnAgent", () => {
  it("binds emission + lookup tools and a fresh collector", () => {
    const { agent, collector } = buildWaveMidTurnAgent({ seed: SEED, courseId: COURSE_ID });
    // Tool surface is the contract the prompt + client rely on.
    expect(Object.keys(agent.tools).sort()).toEqual([
      "getConceptHistory",
      "getDueConcepts",
      "presentQuestionnaire",
      "recordComprehensionSignals",
    ]);
    expect(collector).toEqual({ questionnaire: null, signals: [] });
  });

  it("builds a FRESH collector + tool set per call (retry isolation)", () => {
    const first = buildWaveMidTurnAgent({ seed: SEED, courseId: COURSE_ID });
    const second = buildWaveMidTurnAgent({ seed: SEED, courseId: COURSE_ID });
    expect(first.collector).not.toBe(second.collector);
    expect(first.agent).not.toBe(second.agent);
  });

  it("instructions are byte-identical to the rendered wave system prompt", () => {
    // renderContext.system === renderTeachingSystem(seed) for wave seeds —
    // the agent MUST NOT drift from what the message-assembly path renders,
    // or the provider cache prefix breaks (renderContext invariant).
    const { instructions } = buildWaveMidTurnAgent({ seed: SEED, courseId: COURSE_ID });
    expect(instructions).toBe(renderTeachingSystem(SEED));
  });

  it("forces the tools output contract regardless of the seed's", () => {
    const { instructions } = buildWaveMidTurnAgent({
      seed: { ...SEED, outputContract: undefined },
      courseId: COURSE_ID,
    });
    // The agent path IS the tool channel; a "json"-contract prompt would
    // instruct mega-schema output into a tool loop.
    expect(instructions).toBe(renderTeachingSystem({ ...SEED, outputContract: "tools" }));
    expect(instructions).toContain("presentQuestionnaire");
  });
});
