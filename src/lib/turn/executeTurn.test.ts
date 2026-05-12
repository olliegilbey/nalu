import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { executeTurn } from "./executeTurn";

vi.mock("@/lib/llm/generate", () => ({
  generateChat: vi.fn(),
}));
vi.mock("@/db/queries/contextMessages", () => ({
  appendMessages: vi.fn(),
  getMessagesForWave: vi.fn(),
  getMessagesForScopingPass: vi.fn(),
  getNextTurnIndex: vi.fn(),
}));

import { generateChat } from "@/lib/llm/generate";
import {
  appendMessages,
  getMessagesForScopingPass,
  getNextTurnIndex,
} from "@/db/queries/contextMessages";

const SCOPING_ID = "00000000-0000-0000-0000-000000000601";
const SEED = { kind: "scoping" as const, topic: "Rust" };
// Full LanguageModelUsage shape (AI SDK v5) — detail sub-objects required.
const FAKE_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

beforeEach(() => {
  vi.mocked(generateChat).mockReset();
  vi.mocked(appendMessages).mockReset();
  vi.mocked(getMessagesForScopingPass).mockReset();
  vi.mocked(getNextTurnIndex).mockReset();
  vi.mocked(getMessagesForScopingPass).mockResolvedValue([]);
  vi.mocked(getNextTurnIndex).mockResolvedValue(0);
  vi.mocked(appendMessages).mockResolvedValue([]);
});

describe("executeTurn", () => {
  it("happy path: parser succeeds on first attempt, writes user + assistant rows", async () => {
    vi.mocked(generateChat).mockResolvedValueOnce({ text: "OK_RAW", usage: FAKE_USAGE });
    const parser = vi.fn((raw: string) => ({ value: raw }));
    const result = await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hello",
      parser,
    });
    expect(result.parsed).toEqual({ value: "OK_RAW" });
    expect(result.usage).toEqual(FAKE_USAGE);
    expect(parser).toHaveBeenCalledOnce();
    expect(appendMessages).toHaveBeenCalledOnce();
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch).toHaveLength(2);
    expect(batch[0]!.kind).toBe("user_message");
    expect(batch[1]!.kind).toBe("assistant_response");
  });

  it("retry-then-success: persists failed + directive + success rows in one batch", async () => {
    vi.mocked(generateChat)
      .mockResolvedValueOnce({ text: "BAD_RAW", usage: FAKE_USAGE })
      .mockResolvedValueOnce({ text: "GOOD_RAW", usage: FAKE_USAGE });
    const parser = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new ValidationGateFailure("missing_response", "fix the thing");
      })
      .mockImplementationOnce((raw: string) => ({ value: raw }));
    const r = await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hi",
      parser,
    });
    expect(r.parsed).toEqual({ value: "GOOD_RAW" });
    expect(parser).toHaveBeenCalledTimes(2);
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((b) => b.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "assistant_response",
    ]);
    expect(batch[2]!.content).toContain("fix the thing");
  });

  it("terminal exhaust: persists failure trail and throws ValidationGateFailure", async () => {
    vi.mocked(generateChat).mockResolvedValue({ text: "BAD_RAW", usage: FAKE_USAGE });
    const parser = vi.fn().mockImplementation(() => {
      throw new ValidationGateFailure("missing_response", "still broken");
    });
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        parser,
      }),
    ).rejects.toBeInstanceOf(ValidationGateFailure);
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((b) => b.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "failed_assistant_response",
      "harness_retry_directive",
      "failed_assistant_response",
    ]);
  });

  it("transport error mid-loop: propagates without persisting", async () => {
    vi.mocked(generateChat).mockRejectedValueOnce(new Error("LLM 503"));
    const parser = vi.fn();
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        parser,
      }),
    ).rejects.toThrow("LLM 503");
    expect(appendMessages).not.toHaveBeenCalled();
    expect(parser).not.toHaveBeenCalled();
  });
});
