import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import { executeToolTurnStream, type ToolTurnAgent } from "./executeToolTurnStream";

vi.mock("@/db/queries/contextMessages", () => ({
  appendMessages: vi.fn(),
  getMessagesForWave: vi.fn(),
  getMessagesForScopingPass: vi.fn(),
  getNextTurnIndex: vi.fn(),
}));
// renderContext is exercised by its own tests; stub so wave-seed fixtures
// don't need full population to verify dispatch + persistence logic.
vi.mock("@/lib/llm/renderContext", () => ({
  renderContext: vi.fn(() => ({ system: "SYS", messages: [] })),
}));

import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
} from "@/db/queries/contextMessages";

const WAVE_ID = "00000000-0000-0000-0000-000000000801";
const WAVE_SEED = { kind: "wave" } as unknown as Parameters<
  typeof executeToolTurnStream
>[0]["seed"];
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/** Canned tool-call step: model called one tool, got one result, wrote optional text. */
const toolStep = (text: string) => ({
  text,
  toolCalls: [{ toolCallId: "c1", toolName: "presentQuestionnaire", input: { questions: [] } }],
  toolResults: [
    {
      toolCallId: "c1",
      toolName: "presentQuestionnaire",
      output: { accepted: true, questionCount: 1 },
    },
  ],
  content: [],
});

/** Canned closing-prose step: no tool calls. */
const textStep = (text: string) => ({ text, toolCalls: [], toolResults: [], content: [] });

/**
 * Stub agent exposing `.stream()` — the mock seam (plan Task 4 Step 1). Shape
 * mirrors the slice of `StreamTextResult` the dispatcher consumes: fullStream
 * to drain, then the `steps` / `totalUsage` promises.
 */
function agentOf(parts: readonly { type: string; [k: string]: unknown }[], steps: unknown[]) {
  // Explicit fn generic (not an implementation param) so `stream.mock.calls`
  // is typed without an unused-parameter warning.
  const stream = vi.fn<(options: { messages: readonly { role: string }[] }) => Promise<unknown>>(
    async () => ({
      fullStream: (async function* () {
        for (const p of parts) yield p;
      })(),
      steps: Promise.resolve(steps),
      totalUsage: Promise.resolve(usage),
    }),
  );
  return { agent: { stream } as unknown as ToolTurnAgent, stream };
}

const noopHooks = {
  onTextDelta: () => undefined,
  onAttemptStart: () => undefined,
};

beforeEach(() => {
  vi.mocked(appendMessages).mockReset();
  vi.mocked(getMessagesForScopingPass).mockReset();
  vi.mocked(getMessagesForWave).mockReset();
  vi.mocked(getNextTurnIndex).mockReset();
  vi.mocked(getMessagesForWave).mockResolvedValue([]);
  vi.mocked(getMessagesForScopingPass).mockResolvedValue([]);
  vi.mocked(getNextTurnIndex).mockResolvedValue(3);
  vi.mocked(appendMessages).mockResolvedValue([]);
});

describe("executeToolTurnStream", () => {
  it("happy path persists user_message, assistant_tool_call, tool_result, assistant_response", async () => {
    const { agent } = agentOf([], [toolStep("Grading done."), textStep("Here is your quiz.")]);

    const result = await executeToolTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "<stage>teaching turn</stage>",
      makeAttempt: () => ({ agent, validateTurn: () => null }),
      ...noopHooks,
    });

    expect(result.finalText).toBe("Here is your quiz.");
    expect(result.usage).toEqual(usage);

    const batch = vi.mocked(appendMessages).mock.calls[0]?.[0];
    expect(batch?.map((r) => [r.kind, r.role, r.seq])).toEqual([
      ["user_message", "user", 0],
      ["assistant_tool_call", "assistant", 1],
      ["tool_result", "tool", 2],
      ["assistant_response", "assistant", 3],
    ]);
    // Tool rows carry the documented JSON contracts, on the reserved turnIndex.
    expect(batch?.every((r) => r.turnIndex === 3)).toBe(true);
    expect(JSON.parse(batch?.[1]?.content ?? "")).toEqual({
      text: "Grading done.",
      toolCalls: [{ toolCallId: "c1", toolName: "presentQuestionnaire", input: { questions: [] } }],
    });
    expect(JSON.parse(batch?.[2]?.content ?? "")).toEqual({
      results: [
        {
          toolCallId: "c1",
          toolName: "presentQuestionnaire",
          output: { accepted: true, questionCount: 1 },
        },
      ],
    });
  });

  it("a pure-text turn persists only user_message + assistant_response (Phase-2 shape)", async () => {
    const { agent } = agentOf([], [textStep("Just teaching.")]);
    await executeToolTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "u",
      makeAttempt: () => ({ agent, validateTurn: () => null }),
      ...noopHooks,
    });
    const batch = vi.mocked(appendMessages).mock.calls[0]?.[0];
    expect(batch?.map((r) => r.kind)).toEqual(["user_message", "assistant_response"]);
  });

  it("dispatches WITHOUT a leading system message — the agent carries instructions", async () => {
    // assembleLlmMessages renders system-first (renderContext stub → "SYS");
    // ToolLoopAgent maps constructor instructions → system and passes
    // messages through untouched, so sending the rendered system row too
    // would double it on the wire. The dispatcher must drop it.
    const { agent, stream } = agentOf([], [textStep("Hi.")]);
    await executeToolTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "u",
      makeAttempt: () => ({ agent, validateTurn: () => null }),
      ...noopHooks,
    });
    expect(stream).toHaveBeenCalledTimes(1);
    const messages = stream.mock.calls[0]![0].messages;
    expect(messages.some((m) => m.role === "system")).toBe(false);
  });

  it("forwards text deltas as-is and tool events to onToolEvent", async () => {
    const { agent } = agentOf(
      [
        { type: "text-delta", id: "t1", text: "Hel" },
        { type: "tool-input-start", id: "c1", toolName: "presentQuestionnaire" },
        { type: "tool-call", toolCallId: "c1", toolName: "presentQuestionnaire", input: {} },
        { type: "text-delta", id: "t2", text: "lo" },
        { type: "finish", finishReason: "stop" },
      ],
      [textStep("Hello")],
    );
    const deltas: string[] = [];
    const toolEvents: string[] = [];
    await executeToolTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "u",
      makeAttempt: () => ({ agent, validateTurn: () => null }),
      onTextDelta: (d) => deltas.push(d),
      onAttemptStart: () => undefined,
      onToolEvent: (p) => toolEvents.push(p.type),
    });
    expect(deltas).toEqual(["Hel", "lo"]);
    // `finish` is not a tool event; text deltas flow through onTextDelta only.
    expect(toolEvents).toEqual(["tool-input-start", "tool-call"]);
  });

  it("validateTurn failure persists a JSON exhaust envelope + directive, then retries with a fresh agent", async () => {
    const first = agentOf([], [toolStep(""), textStep("no grading happened")]);
    const second = agentOf([], [toolStep("fixed"), textStep("Recovered prose.")]);

    const attempts: number[] = [];
    const result = await executeToolTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "u",
      makeAttempt: (i) => {
        attempts.push(i);
        return {
          agent: i === 0 ? first.agent : second.agent,
          validateTurn: () =>
            i === 0 ? new ValidationGateFailure("missing_response", "call the grading tool") : null,
        };
      },
      ...noopHooks,
    });

    expect(result.finalText).toBe("Recovered prose.");
    expect(attempts).toEqual([0, 1]); // fresh attempt surface each time
    expect(first.stream).toHaveBeenCalledTimes(1);
    expect(second.stream).toHaveBeenCalledTimes(1);

    const batch = vi.mocked(appendMessages).mock.calls[0]?.[0];
    expect(batch?.map((r) => [r.kind, r.seq])).toEqual([
      ["user_message", 0],
      ["failed_assistant_response", 1],
      ["harness_retry_directive", 2],
      ["assistant_tool_call", 3],
      ["tool_result", 4],
      ["assistant_response", 5],
    ]);
    // Failed attempt persists as ONE JSON envelope row — never as tool-kind
    // rows, which would leak into the recovered turn's rendered context.
    const envelope = JSON.parse(batch?.[1]?.content ?? "") as { steps: unknown[]; text: string };
    expect(envelope.text).toBe("no grading happened");
    expect(envelope.steps).toHaveLength(2);
    expect(batch?.[2]?.content).toBe("call the grading tool");
  });

  it("terminal exhaust persists the trail without a trailing directive and throws the gate", async () => {
    await expect(
      executeToolTurnStream({
        parent: { kind: "wave", id: WAVE_ID },
        seed: WAVE_SEED,
        userMessageContent: "u",
        // A fresh stub agent per attempt; every attempt fails the gate.
        makeAttempt: () => ({
          agent: agentOf([], [textStep("still bad")]).agent,
          validateTurn: () => new ValidationGateFailure("missing_response", "nope"),
        }),
        ...noopHooks,
      }),
    ).rejects.toBeInstanceOf(ValidationGateFailure);

    const batch = vi.mocked(appendMessages).mock.calls[0]?.[0];
    // Last row is the failed response — no trailing directive on terminal exhaust.
    expect(batch?.[batch.length - 1]?.kind).toBe("failed_assistant_response");
  });

  it("persists tool-error feedback into the tool_result row (in-loop self-correction trail)", async () => {
    const stepWithError = {
      text: "",
      toolCalls: [{ toolCallId: "bad", toolName: "presentQuestionnaire", input: { x: 1 } }],
      toolResults: [],
      content: [
        {
          type: "tool-error",
          toolCallId: "bad",
          toolName: "presentQuestionnaire",
          error: "Invalid input",
        },
      ],
    };
    const { agent } = agentOf([], [stepWithError, textStep("recovered in-loop")]);
    await executeToolTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "u",
      makeAttempt: () => ({ agent, validateTurn: () => null }),
      ...noopHooks,
    });
    const batch = vi.mocked(appendMessages).mock.calls[0]?.[0];
    expect(JSON.parse(batch?.[2]?.content ?? "")).toEqual({
      results: [
        {
          toolCallId: "bad",
          toolName: "presentQuestionnaire",
          output: { toolError: "Invalid input" },
        },
      ],
    });
  });
});
