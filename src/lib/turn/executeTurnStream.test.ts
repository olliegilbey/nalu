import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod/v4";
import { NoObjectGeneratedError } from "ai";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { executeTurnStream } from "./executeTurnStream";

vi.mock("@/lib/llm/streamChat", () => ({
  streamChat: vi.fn(),
}));
vi.mock("@/db/queries/contextMessages", () => ({
  appendMessages: vi.fn(),
  getMessagesForWave: vi.fn(),
  getMessagesForScopingPass: vi.fn(),
  getNextTurnIndex: vi.fn(),
}));
// `renderContext` is exercised by its own tests; stub here so wave-seed
// fixtures don't need to be fully populated to verify dispatch logic.
vi.mock("@/lib/llm/renderContext", () => ({
  renderContext: vi.fn(() => ({ system: "SYS", messages: [] })),
}));

import { streamChat } from "@/lib/llm/streamChat";
import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
} from "@/db/queries/contextMessages";

const WAVE_ID = "00000000-0000-0000-0000-000000000701";
// renderContext is mocked → wave seed fields are never inspected.
const WAVE_SEED = { kind: "wave" } as unknown as Parameters<typeof executeTurnStream>[0]["seed"];
const schema = z.object({ userMessage: z.string() });
// Full LanguageModelUsage shape — detail sub-objects required by the type.
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/** Builds a StreamChatHandle whose partials/final are canned. */
function handleOf(partials: readonly unknown[], final: () => Promise<unknown>) {
  return {
    partialOutputStream: (async function* () {
      for (const p of partials) yield p;
    })(),
    final,
  };
}

/** Builds the error streamChat's final() rejects with on parse/validation failure. */
function noObjectError(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    text,
    response: { id: "t", timestamp: new Date(0), modelId: "mock" },
    usage,
    finishReason: "stop",
  });
}

beforeEach(() => {
  vi.mocked(streamChat).mockReset();
  vi.mocked(appendMessages).mockReset();
  vi.mocked(getMessagesForScopingPass).mockReset();
  vi.mocked(getMessagesForWave).mockReset();
  vi.mocked(getNextTurnIndex).mockReset();
  vi.mocked(getMessagesForScopingPass).mockResolvedValue([]);
  vi.mocked(getMessagesForWave).mockResolvedValue([]);
  vi.mocked(getNextTurnIndex).mockResolvedValue(0);
  vi.mocked(appendMessages).mockResolvedValue([]);
});

describe("executeTurnStream", () => {
  it("emits monotonic prose deltas from the projected field", async () => {
    vi.mocked(streamChat).mockResolvedValueOnce(
      handleOf(
        [{ userMessage: "Hel" }, { userMessage: "Hello wor" }, { userMessage: "Hello world" }],
        async () => ({
          parsed: { userMessage: "Hello world" },
          text: '{"userMessage":"Hello world"}',
          usage,
        }),
      ) as never,
    );
    const deltas: string[] = [];
    const result = await executeTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "hi",
      responseSchema: schema,
      progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
      onTextDelta: (d) => deltas.push(d),
      onAttemptStart: () => undefined,
    });
    expect(deltas.join("")).toBe("Hello world");
    expect(result.parsed).toEqual({ userMessage: "Hello world" });
    // Persisted batch: user_message + assistant_response, same as executeTurn.
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((r) => r.kind)).toEqual(["user_message", "assistant_response"]);
  });

  it("on validation failure: signals new attempt, persists failed+directive rows, retries", async () => {
    vi.mocked(streamChat)
      .mockResolvedValueOnce(
        handleOf([{ userMessage: "bad" }], async () => {
          throw noObjectError('{"wrong":1}');
        }) as never,
      )
      .mockResolvedValueOnce(
        handleOf([{ userMessage: "ok" }], async () => ({
          parsed: { userMessage: "ok" },
          text: '{"userMessage":"ok"}',
          usage,
        })) as never,
      );
    const attempts: number[] = [];
    const result = await executeTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "hi",
      responseSchema: schema,
      progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
      onTextDelta: () => undefined,
      onAttemptStart: (i) => attempts.push(i),
    });
    expect(result.parsed).toEqual({ userMessage: "ok" });
    expect(attempts).toEqual([0, 1]);
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((r) => r.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "assistant_response",
    ]);
    // Raw failed text is persisted verbatim, same as executeTurn.
    expect(batch[1]!.content).toBe('{"wrong":1}');
  });

  it("terminal exhaust: persists failure trail and throws ValidationGateFailure", async () => {
    vi.mocked(streamChat).mockResolvedValue(
      handleOf([{ userMessage: "bad" }], async () => {
        throw noObjectError('{"wrong":1}');
      }) as never,
    );
    await expect(
      executeTurnStream({
        parent: { kind: "wave", id: WAVE_ID },
        seed: WAVE_SEED,
        userMessageContent: "hi",
        responseSchema: schema,
        progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
        onTextDelta: () => undefined,
        onAttemptStart: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ValidationGateFailure);
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((r) => r.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "failed_assistant_response",
      "harness_retry_directive",
      "failed_assistant_response",
    ]);
  });

  it("skips non-prefix partials (repair rewrote earlier text)", async () => {
    vi.mocked(streamChat).mockResolvedValueOnce(
      handleOf(
        [{ userMessage: "Hello" }, { userMessage: "Goodbye" }, { userMessage: "Hello world" }],
        async () => ({ parsed: { userMessage: "Hello world" }, text: "{}", usage }),
      ) as never,
    );
    const deltas: string[] = [];
    await executeTurnStream({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "hi",
      responseSchema: schema,
      progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
      onTextDelta: (d) => deltas.push(d),
      onAttemptStart: () => undefined,
    });
    // "Goodbye" is not an extension of "Hello" — skipped; "Hello world" is.
    expect(deltas.join("")).toBe("Hello world");
  });

  it("transport error mid-stream: propagates without persisting", async () => {
    vi.mocked(streamChat).mockRejectedValueOnce(new Error("LLM 503"));
    await expect(
      executeTurnStream({
        parent: { kind: "wave", id: WAVE_ID },
        seed: WAVE_SEED,
        userMessageContent: "hi",
        responseSchema: schema,
        progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
        onTextDelta: () => undefined,
        onAttemptStart: () => undefined,
      }),
    ).rejects.toThrow("LLM 503");
    expect(appendMessages).not.toHaveBeenCalled();
  });
});
