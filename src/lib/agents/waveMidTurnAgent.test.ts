import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { WaveSeedInputs } from "@/lib/types/context";
import { renderTeachingSystem } from "@/lib/prompts/teaching";
import { getRunUsageTally, resetRunUsageTally } from "@/lib/llm/runUsageTally";
import { buildWaveMidTurnAgent } from "./waveMidTurnAgent";

// The provider needs env at import time — stub it. Tests that run the
// loop inject a MockLanguageModelV3 instead.
vi.mock("@/lib/llm/provider", () => ({
  getLlmModel: () => ({ modelId: "stub", specificationVersion: "v3" }),
  llmProviderOptions: () => ({ "nalu-llm": { reasoningEffort: "high" } }),
}));

// The getDueConcepts lookup reads the DB; nothing is due in these tests.
vi.mock("@/db/queries/concepts", () => ({
  getDueConceptsByCourse: vi.fn().mockResolvedValue([]),
  getConceptByNameForCourse: vi.fn(),
}));

/** Token usage every mocked Step reports. */
const STEP_USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 40, text: 40, reasoning: undefined },
} as const;

/**
 * Two-Step mock: a getDueConcepts tool call, then closing prose. A function,
 * not the mock's array form: the array form indexes after recording the
 * call, so its first Step would return element 1.
 */
function twoStepModel(): MockLanguageModelV3 {
  const model: MockLanguageModelV3 = new MockLanguageModelV3({
    doGenerate: async () =>
      model.doGenerateCalls.length === 1
        ? {
            content: [
              { type: "tool-call", toolCallId: "call-1", toolName: "getDueConcepts", input: "{}" },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: STEP_USAGE,
            warnings: [],
          }
        : {
            content: [{ type: "text", text: "Nothing is due yet." }],
            finishReason: { unified: "stop", raw: undefined },
            usage: STEP_USAGE,
            warnings: [],
          },
  });
  return model;
}

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

  it("throws when the seed's output contract is not 'tools'", () => {
    // The agent path IS the tool channel; a "json"-contract prompt would
    // instruct mega-schema output into a tool loop. Silently rewriting the
    // seed would let the agent's instructions diverge from what the caller's
    // message-assembly path rendered and persisted — throw instead, matching
    // buildWaveSeed's loud-explicit contract param (PR #35 review).
    expect(() =>
      buildWaveMidTurnAgent({ seed: { ...SEED, outputContract: undefined }, courseId: COURSE_ID }),
    ).toThrowError(/outputContract: "tools"/);
    expect(() =>
      buildWaveMidTurnAgent({ seed: { ...SEED, outputContract: "json" }, courseId: COURSE_ID }),
    ).toThrowError(/outputContract: "tools"/);
  });

  it("folds every loop Step's usage into the run tally", async () => {
    // Each Step is one billed provider call. The tool loop bypasses
    // generateChat, so the agent's onStepFinish must record usage itself.
    resetRunUsageTally();
    const { agent } = buildWaveMidTurnAgent({
      seed: SEED,
      courseId: COURSE_ID,
      model: twoStepModel(),
    });

    const result = await agent.generate({ messages: [{ role: "user", content: "hi" }] });

    // Guard the fixture: the loop really ran two Steps.
    expect(result.steps).toHaveLength(2);

    expect(getRunUsageTally()).toMatchObject({ steps: 2, inputTokens: 200, outputTokens: 80 });
  });
});
