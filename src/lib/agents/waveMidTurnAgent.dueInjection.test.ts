import { describe, it, expect, vi } from "vitest";
import type { WaveSeedInputs } from "@/lib/types/context";
import { renderTeachingSystem } from "@/lib/prompts/teaching";
import { buildWaveMidTurnAgent } from "./waveMidTurnAgent";

// Hint mode is a module-level tuning flag, so it gets its own test file with
// the tuning mocked file-wide (a per-test mock would leak into the default-
// mode assertions in waveMidTurnAgent.test.ts).
vi.mock("@/lib/config/tuning", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/config/tuning")>();
  return { ...orig, WAVE: { ...orig.WAVE, dueReviewInjection: "hint" } };
});

// The provider needs env at import time; these tests never run the loop.
vi.mock("@/lib/llm/provider", () => ({
  getLlmModel: () => ({ modelId: "stub", specificationVersion: "v3" }),
  llmProviderOptions: () => ({}),
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
  dueConcepts: [{ conceptId: "c-1", name: "Borrowing", tier: 1, lastQuality: 3 }],
};

/** Agent params for a chat-text turn: no questions answered. */
const CHAT_TURN = {
  seed: SEED,
  courseId: "11111111-1111-4111-8111-111111111111",
  waveId: "22222222-2222-4222-8222-222222222222",
  answeredQuestionIds: [],
} as const;

describe("buildWaveMidTurnAgent (dueReviewInjection: hint)", () => {
  // Audit F4: the hint asks the model to call getDueConcepts, so hint mode
  // keeps the tool that "full" mode drops.
  it("offers the getDueConcepts lookup", () => {
    const { agent } = buildWaveMidTurnAgent(CHAT_TURN);
    expect(Object.keys(agent.tools).sort()).toEqual([
      "getConceptHistory",
      "getDueConcepts",
      "presentQuestionnaire",
      "recordComprehensionSignals",
    ]);
  });

  // The tool list rides the request; the pre-F4 order keeps its bytes.
  it("keeps the pre-F4 lookup order", () => {
    const { agent } = buildWaveMidTurnAgent(CHAT_TURN);
    expect(Object.keys(agent.tools).filter((name) => name.startsWith("get"))).toEqual([
      "getDueConcepts",
      "getConceptHistory",
    ]);
  });

  it("instructions are byte-identical to the rendered wave system prompt", () => {
    const { instructions } = buildWaveMidTurnAgent(CHAT_TURN);
    expect(instructions).toBe(renderTeachingSystem(SEED));
    expect(instructions).toContain("getDueConcepts");
  });
});
