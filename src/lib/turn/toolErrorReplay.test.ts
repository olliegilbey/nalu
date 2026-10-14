import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3Message, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod/v4";
import type { ContextMessage } from "@/db/schema";
import type { AppendMessageParams } from "@/db/queries/contextMessages";
import type { WaveSeedInputs } from "@/lib/types/context";
import { executeToolTurnStream } from "./executeToolTurnStream";
import { assembleLlmMessages, synthesiseRows } from "./contextAssembly";

// Issues #147 and #163: a tool error and the call that caused it must
// replay on the next Turn as the same bytes the loop sent in-loop, or the
// provider's prompt cache misses from there.

vi.mock("@/db/queries/contextMessages.writes", () => ({
  appendMessages: vi.fn(),
}));
vi.mock("@/db/queries/contextMessages", () => ({
  getMessagesForWave: vi.fn(),
  getMessagesForScopingPass: vi.fn(),
  getNextTurnIndex: vi.fn(),
}));

import { appendMessages } from "@/db/queries/contextMessages.writes";
import { getMessagesForWave, getNextTurnIndex } from "@/db/queries/contextMessages";

const PARENT = { kind: "wave", id: "00000000-0000-0000-0000-000000000801" } as const;

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
  courseSummary: null,
  seedSource: {
    kind: "scoping_handoff",
    blueprint: { topic: "Ownership", outline: ["x"], openingText: "hi", plannedConcepts: [] },
  },
  dueConcepts: [],
};

/** Usage every mocked Step reports. */
const STEP_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

/** How long a successful `lookUp` takes. */
const LOOKUP_SUCCESS_DELAY_MS = 10;

/** How long `lookUp` takes for the name "slow", so a later call's result lands first. */
const SLOW_LOOKUP_DELAY_MS = 30;

/**
 * A streamed Step: optional prose, then one `lookUp` call per input
 * (`call-1`, `call-2`, …), then finish.
 */
function stepChunks(step: {
  readonly text?: string;
  readonly toolInputs?: readonly string[];
}): LanguageModelV3StreamPart[] {
  const prose: LanguageModelV3StreamPart[] =
    step.text === undefined
      ? []
      : [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: step.text },
          { type: "text-end", id: "t1" },
        ];
  const calls = (step.toolInputs ?? []).map(
    (input, i): LanguageModelV3StreamPart => ({
      type: "tool-call",
      toolCallId: `call-${i + 1}`,
      toolName: "lookUp",
      input,
    }),
  );
  const unified = calls.length === 0 ? "stop" : "tool-calls";
  return [
    ...prose,
    ...calls,
    { type: "finish", finishReason: { unified, raw: undefined }, usage: STEP_USAGE },
  ];
}

/** Mock model that plays one scripted Step per provider call, in order. */
function scriptedModel(steps: readonly LanguageModelV3StreamPart[][]): MockLanguageModelV3 {
  const model: MockLanguageModelV3 = new MockLanguageModelV3({
    doStream: async () => ({
      // doStreamCalls already holds this call, so length - 1 is its index.
      stream: simulateReadableStream({ chunks: steps[model.doStreamCalls.length - 1] ?? [] }),
    }),
  });
  return model;
}

/**
 * A one-tool agent. `lookUp` throws `Error("lookup failed")` for the name
 * "missing"; any other name resolves `{found: name}` after a short delay,
 * or a longer one for "slow".
 */
function agentOn(model: MockLanguageModelV3) {
  return new ToolLoopAgent({
    model,
    tools: {
      lookUp: tool({
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          if (name === "missing") throw new Error("lookup failed");
          const delayMs = name === "slow" ? SLOW_LOOKUP_DELAY_MS : LOOKUP_SUCCESS_DELAY_MS;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { found: name };
        },
      }),
    },
    stopWhen: stepCountIs(3),
  });
}

/**
 * Run one Turn through the real dispatcher. Returns the rows it persisted,
 * and the call ids of its tool results and errors in arrival order.
 */
async function runTurn(
  model: MockLanguageModelV3,
  turnIndex: number,
  priorRows: readonly ContextMessage[],
): Promise<{ readonly rows: readonly AppendMessageParams[]; readonly arrived: string[] }> {
  vi.mocked(getNextTurnIndex).mockResolvedValue(turnIndex);
  vi.mocked(getMessagesForWave).mockResolvedValue([...priorRows]);
  vi.mocked(appendMessages).mockClear();
  // Filled by the stream callback, in the order the parts arrive.
  const arrived: string[] = [];
  await executeToolTurnStream({
    parent: PARENT,
    seed: SEED,
    userMessageContent: `turn ${turnIndex}`,
    makeAttempt: () => ({ agent: agentOn(model), validateTurn: () => null }),
    onTextDelta: () => undefined,
    onAttemptStart: () => undefined,
    onToolEvent: (part) => {
      if (part.type === "tool-result" || part.type === "tool-error") arrived.push(part.toolCallId);
    },
  });
  return { rows: vi.mocked(appendMessages).mock.calls[0]?.[0] ?? [], arrived };
}

/** A provider-level assistant message. */
type AssistantMessage = Extract<LanguageModelV3Message, { role: "assistant" }>;

/** A provider-level tool message: one Step's tool results. */
type ToolMessage = Extract<LanguageModelV3Message, { role: "tool" }>;

/** One Step's tool exchange: the assistant message that made the calls, then their results. */
interface ToolExchange {
  readonly calls: AssistantMessage;
  readonly results: ToolMessage;
}

/** The one tool exchange in a provider-level prompt. */
function toolExchangeOf(prompt: readonly LanguageModelV3Message[]): ToolExchange {
  const calls = prompt.filter(
    (m): m is AssistantMessage =>
      m.role === "assistant" && m.content.some((p) => p.type === "tool-call"),
  );
  const results = prompt.filter((m): m is ToolMessage => m.role === "tool");
  expect(calls).toHaveLength(1);
  expect(results).toHaveLength(1);
  return { calls: calls[0] as AssistantMessage, results: results[0] as ToolMessage };
}

/**
 * Run a Turn whose first Step makes the given tool calls, then replay its
 * rows on the next Turn. Returns the tool exchange from each side: the
 * in-loop Step 2 prompt, and the next Turn's first prompt. Also returns
 * the order the results arrived in during Turn 0.
 */
async function inLoopAndReplayed(toolInputs: readonly string[]): Promise<{
  readonly inLoop: ToolExchange;
  readonly replayed: ToolExchange;
  readonly arrived: readonly string[];
}> {
  // Turn 0: Step 1 makes the calls; Step 2 recovers in prose.
  const loopModel = scriptedModel([stepChunks({ toolInputs }), stepChunks({ text: "Recovered." })]);
  const { rows, arrived } = await runTurn(loopModel, 0, []);
  // Turn 1 loads Turn 0's rows from the DB and replays them.
  const nextModel = scriptedModel([stepChunks({ text: "Next." })]);
  await runTurn(nextModel, 1, synthesiseRows([], rows));
  return {
    inLoop: toolExchangeOf(loopModel.doStreamCalls[1]?.prompt ?? []),
    replayed: toolExchangeOf(nextModel.doStreamCalls[0]?.prompt ?? []),
    arrived,
  };
}

/** The call ids of a tool message's results, in order. */
function resultIdsOf(results: ToolMessage): readonly (string | false)[] {
  return results.content.map((p) => p.type === "tool-result" && p.toolCallId);
}

beforeEach(() => {
  vi.mocked(appendMessages).mockReset();
  vi.mocked(appendMessages).mockResolvedValue([]);
});

describe("tool-error replay (#147)", () => {
  it.each([
    // Valid input, so the tool runs and its execute throws.
    { cause: "execute throws", toolInput: JSON.stringify({ name: "missing" }) },
    // Parseable JSON that fails the input schema: InvalidToolInputError.
    // The SDK keeps the parsed object as the call's input.
    { cause: "input fails validation", toolInput: JSON.stringify({ name: 7 }) },
  ])("replays a tool error ($cause) as the bytes the loop sent", async ({ toolInput }) => {
    const { inLoop, replayed } = await inLoopAndReplayed([toolInput]);
    expect(replayed).toEqual(inLoop);
  });

  it("replays an unparseable tool-call input as the {} the loop sent (#163)", async () => {
    // Not JSON, so the SDK marks the call invalid. In-loop it sends the
    // call's input as {}, not the raw string.
    const { inLoop, replayed } = await inLoopAndReplayed(['{"name": ']);
    // Guard the fixture: the loop really sent {}.
    expect(inLoop.calls.content.find((p) => p.type === "tool-call")?.input).toEqual({});
    expect(replayed).toEqual(inLoop);
  });

  it("replays results in the order the loop sent them: tool-call order", async () => {
    // call-1 is slow, so call-2's result arrives first. Since ai 6.0.220 the
    // loop sorts results into tool-call order before it sends them.
    const { inLoop, replayed, arrived } = await inLoopAndReplayed([
      JSON.stringify({ name: "slow" }),
      JSON.stringify({ name: "borrowing" }),
    ]);
    // Guard the fixture: arrival and send order really differ.
    expect(arrived).toEqual(["call-2", "call-1"]);
    expect(resultIdsOf(inLoop.results)).toEqual(["call-1", "call-2"]);
    expect(JSON.stringify(replayed.results)).toBe(JSON.stringify(inLoop.results));
  });

  it("replays an invalid call's early error in tool-call order", async () => {
    // Since ai 6.0.260 valid calls run only after the Step's finish chunk,
    // while an invalid input's error lands at once. call-2's error arrives
    // before call-1's result; the loop still sends call-1 first.
    const { inLoop, replayed, arrived } = await inLoopAndReplayed([
      JSON.stringify({ name: "borrowing" }),
      JSON.stringify({ name: 7 }),
    ]);
    expect(arrived).toEqual(["call-2", "call-1"]);
    expect(resultIdsOf(inLoop.results)).toEqual(["call-1", "call-2"]);
    expect(JSON.stringify(replayed.results)).toBe(JSON.stringify(inLoop.results));
  });

  it("renders a tool_result row written before #147 to its old bytes", () => {
    // Old rows stored `{toolError: String(error)}` and replayed it as JSON.
    // Re-rendering them differently would shift every cached prefix that
    // holds one, so their bytes are pinned.
    const legacyRow: AppendMessageParams = {
      parent: PARENT,
      turnIndex: 0,
      seq: 2,
      kind: "tool_result",
      role: "tool",
      content:
        '{"results":[{"toolCallId":"call-1","toolName":"lookUp","output":{"toolError":"Error: lookup failed"}}]}',
    };
    const messages = assembleLlmMessages(SEED, [], [legacyRow]);
    expect(JSON.stringify(messages[1])).toBe(
      '{"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1","toolName":"lookUp","output":{"type":"json","value":{"toolError":"Error: lookup failed"}}}]}',
    );
  });
});
