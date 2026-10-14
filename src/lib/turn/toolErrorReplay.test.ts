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

// Issue #147: a tool error must replay on the next Turn as the same bytes
// the loop sent in-loop, or the provider's prompt cache misses from there.

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

/** A streamed Step: optional prose, then optional tool calls, then finish. */
function stepChunks(step: {
  readonly text?: string;
  readonly toolInput?: string;
}): LanguageModelV3StreamPart[] {
  const prose: LanguageModelV3StreamPart[] =
    step.text === undefined
      ? []
      : [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: step.text },
          { type: "text-end", id: "t1" },
        ];
  const call: LanguageModelV3StreamPart[] =
    step.toolInput === undefined
      ? []
      : [{ type: "tool-call", toolCallId: "call-1", toolName: "lookUp", input: step.toolInput }];
  const unified = step.toolInput === undefined ? "stop" : "tool-calls";
  return [
    ...prose,
    ...call,
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

/** A one-tool agent whose tool always throws `Error("lookup failed")`. */
function agentOn(model: MockLanguageModelV3) {
  return new ToolLoopAgent({
    model,
    tools: {
      lookUp: tool({
        inputSchema: z.object({ name: z.string() }),
        execute: async (): Promise<string> => {
          throw new Error("lookup failed");
        },
      }),
    },
    stopWhen: stepCountIs(3),
  });
}

/** Run one Turn through the real dispatcher; return the rows it persisted. */
async function runTurn(
  model: MockLanguageModelV3,
  turnIndex: number,
  priorRows: readonly ContextMessage[],
): Promise<readonly AppendMessageParams[]> {
  vi.mocked(getNextTurnIndex).mockResolvedValue(turnIndex);
  vi.mocked(getMessagesForWave).mockResolvedValue([...priorRows]);
  vi.mocked(appendMessages).mockClear();
  await executeToolTurnStream({
    parent: PARENT,
    seed: SEED,
    userMessageContent: `turn ${turnIndex}`,
    makeAttempt: () => ({ agent: agentOn(model), validateTurn: () => null }),
    onTextDelta: () => undefined,
    onAttemptStart: () => undefined,
  });
  return vi.mocked(appendMessages).mock.calls[0]?.[0] ?? [];
}

/** The one tool message in a provider-level prompt. */
function toolMessageOf(prompt: readonly LanguageModelV3Message[]): LanguageModelV3Message {
  const tools = prompt.filter((m) => m.role === "tool");
  expect(tools).toHaveLength(1);
  return tools[0] as LanguageModelV3Message;
}

beforeEach(() => {
  vi.mocked(appendMessages).mockReset();
  vi.mocked(appendMessages).mockResolvedValue([]);
});

describe("tool-error replay (#147)", () => {
  it.each([
    // Valid input, so the tool runs and its execute throws.
    { cause: "execute throws", toolInput: JSON.stringify({ name: "borrowing" }) },
    // Parseable JSON that fails the input schema: InvalidToolInputError.
    // Unparseable JSON also diverges in the assistant tool-call message (#163).
    { cause: "input fails validation", toolInput: JSON.stringify({ name: 7 }) },
  ])("replays a tool error ($cause) as the bytes the loop sent", async ({ toolInput }) => {
    // Turn 0: Step 1 calls the tool and it errors; Step 2 recovers in prose.
    const loopModel = scriptedModel([
      stepChunks({ toolInput }),
      stepChunks({ text: "Recovered." }),
    ]);
    const persisted = await runTurn(loopModel, 0, []);
    // The in-loop Step 2 prompt carries the tool error exactly as the SDK sent it.
    const inLoop = toolMessageOf(loopModel.doStreamCalls[1]?.prompt ?? []);

    // Turn 1 loads Turn 0's rows from the DB and replays them.
    const nextModel = scriptedModel([stepChunks({ text: "Next." })]);
    await runTurn(nextModel, 1, synthesiseRows([], persisted));
    const replayed = toolMessageOf(nextModel.doStreamCalls[0]?.prompt ?? []);

    expect(replayed).toEqual(inLoop);
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
