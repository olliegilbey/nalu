import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { WaveSeedInputs } from "@/lib/types/context";
import { renderTeachingSystem } from "@/lib/prompts/teaching";
import { getRunUsageTally, resetRunUsageTally } from "@/lib/llm/runUsageTally";
import { buildWaveMidTurnAgent } from "./waveMidTurnAgent";

// The provider model needs env — stub it. Tests that run the loop inject a
// MockLanguageModelV3 instead. llmProviderOptions stays real.
vi.mock("@/lib/llm/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/provider")>()),
  getLlmModel: () => ({ modelId: "stub", specificationVersion: "v3" }),
}));

// The getConceptHistory lookup reads the DB; no concept matches in these tests.
vi.mock("@/db/queries/concepts", () => ({
  getDueConceptsByCourse: vi.fn(),
  getConceptByNameForCourse: vi.fn().mockResolvedValue(null),
}));

/** Input for the default mocked lookup call. */
const LOOKUP_INPUT = JSON.stringify({ conceptName: "ownership" });

/** Token usage every mocked Step reports. */
const STEP_USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 40, text: 40, reasoning: undefined },
} as const;

/**
 * Two-Step mock: one tool call (default getConceptHistory), then closing prose.
 * A function, not the mock's array form: the array form indexes after
 * recording the call, so its first Step would return element 1.
 */
function twoStepModel(toolName = "getConceptHistory", input = LOOKUP_INPUT): MockLanguageModelV3 {
  const model: MockLanguageModelV3 = new MockLanguageModelV3({
    doGenerate: async () =>
      model.doGenerateCalls.length === 1
        ? {
            content: [{ type: "tool-call", toolCallId: "call-1", toolName, input }],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: STEP_USAGE,
            warnings: [],
          }
        : {
            content: [{ type: "text", text: "No history yet." }],
            finishReason: { unified: "stop", raw: undefined },
            usage: STEP_USAGE,
            warnings: [],
          },
  });
  return model;
}

/**
 * Streamed twin of {@link twoStepModel}: the production path, since every
 * mid-Wave turn runs `agent.stream`. Usage rides on each Step's finish
 * chunk, as with `stream_options.include_usage` on the wire.
 */
function twoStepStreamModel(): MockLanguageModelV3 {
  const finish = (unified: "tool-calls" | "stop"): LanguageModelV3StreamPart => ({
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: STEP_USAGE,
  });
  const toolCallStep: readonly LanguageModelV3StreamPart[] = [
    { type: "tool-call", toolCallId: "call-1", toolName: "getConceptHistory", input: LOOKUP_INPUT },
    finish("tool-calls"),
  ];
  const proseStep: readonly LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "No history yet." },
    { type: "text-end", id: "t1" },
    finish("stop"),
  ];
  const model: MockLanguageModelV3 = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [...(model.doStreamCalls.length === 1 ? toolCallStep : proseStep)],
      }),
    }),
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
};

const COURSE_ID = "11111111-1111-4111-8111-111111111111";

/** Agent params for a chat-text turn: no questions answered. */
const CHAT_TURN = {
  seed: SEED,
  courseId: COURSE_ID,
  waveId: "22222222-2222-4222-8222-222222222222",
  answeredQuestionIds: [],
} as const;

describe("buildWaveMidTurnAgent", () => {
  it("binds emission + lookup tools and a fresh collector", () => {
    const { agent, collector } = buildWaveMidTurnAgent(CHAT_TURN);
    // Tool surface is the contract the prompt + client rely on. Default
    // "full" mode offers no getDueConcepts: <due_for_review> already lists
    // the due set, so the call only burned a loop Step (audit F4). Hint mode
    // keeps it (waveMidTurnAgent.dueInjection.test.ts).
    expect(Object.keys(agent.tools).sort()).toEqual([
      "getConceptHistory",
      "presentQuestionnaire",
      "recordComprehensionSignals",
    ]);
    expect(collector).toEqual({ questionnaire: null, signals: [] });
  });

  it("builds a FRESH collector + tool set per call (retry isolation)", () => {
    const first = buildWaveMidTurnAgent(CHAT_TURN);
    const second = buildWaveMidTurnAgent(CHAT_TURN);
    expect(first.collector).not.toBe(second.collector);
    expect(first.agent).not.toBe(second.agent);
  });

  it("instructions are byte-identical to the rendered wave system prompt", () => {
    // renderContext.system === renderTeachingSystem(seed) for wave seeds —
    // the agent MUST NOT drift from what the message-assembly path renders,
    // or the provider cache prefix breaks (renderContext invariant).
    const { instructions } = buildWaveMidTurnAgent(CHAT_TURN);
    expect(instructions).toBe(renderTeachingSystem(SEED));
  });

  it("sends the Wave's prompt cache key on every loop Step (#146)", async () => {
    // Each Step is one request in the Wave's Context, so each carries the
    // key. A prepareStep that returned providerOptions would drop it.
    const model = twoStepStreamModel();
    const { agent } = buildWaveMidTurnAgent({ ...CHAT_TURN, model });

    const result = await agent.stream({ messages: [{ role: "user", content: "hi" }] });
    for await (const part of result.fullStream) {
      void part; // drain, as executeToolTurnStream does
    }

    const sentKeys = model.doStreamCalls.map(
      (call) => call.providerOptions?.["nalu-llm"]?.["prompt_cache_key"],
    );
    expect(sentKeys).toEqual([CHAT_TURN.waveId, CHAT_TURN.waveId]);
  });

  it("folds every loop Step's usage into the run tally", async () => {
    // Each Step is one billed provider call. The tool loop bypasses
    // generateChat, so the agent's onStepFinish must record usage itself.
    resetRunUsageTally();
    const { agent } = buildWaveMidTurnAgent({ ...CHAT_TURN, model: twoStepModel() });

    const result = await agent.generate({ messages: [{ role: "user", content: "hi" }] });

    // Guard the fixture: the loop really ran two Steps.
    expect(result.steps).toHaveLength(2);

    expect(getRunUsageTally()).toMatchObject({ steps: 2, inputTokens: 200, outputTokens: 80 });
  });

  it("folds every streamed loop Step's usage into the run tally", async () => {
    // The production path: executeToolTurnStream drives agent.stream.
    resetRunUsageTally();
    const { agent } = buildWaveMidTurnAgent({ ...CHAT_TURN, model: twoStepStreamModel() });

    const result = await agent.stream({ messages: [{ role: "user", content: "hi" }] });
    for await (const part of result.fullStream) {
      void part; // drain, as executeToolTurnStream does
    }

    // Guard the fixture: the loop really ran two Steps.
    expect(await result.steps).toHaveLength(2);
    expect(getRunUsageTally()).toMatchObject({ steps: 2, inputTokens: 200, outputTokens: 80 });
  });

  // Issue #144: the answered ids reach the grading tool by closure, so a
  // partial call learns in-loop which answers still lack a grade.
  it("binds the answered ids into the grading tool's result", async () => {
    const partialCall = JSON.stringify({
      signals: [{ kind: "mc-index", questionId: "q1", rationale: "Grasp. Extend." }],
    });
    const { agent } = buildWaveMidTurnAgent({
      ...CHAT_TURN,
      answeredQuestionIds: ["q1", "q2"],
      model: twoStepModel("recordComprehensionSignals", partialCall),
    });

    const result = await agent.generate({ messages: [{ role: "user", content: "answers" }] });

    expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({
      recorded: 1,
      stillUngraded: ["q2"],
    });
  });
});
