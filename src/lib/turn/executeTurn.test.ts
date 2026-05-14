import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod/v4";
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
// `renderContext` is exercised by its own tests; stub here so wave-seed
// fixtures don't need to be fully populated to verify dispatch logic.
vi.mock("@/lib/llm/renderContext", () => ({
  renderContext: vi.fn(() => ({ system: "SYS", messages: [] })),
}));

import { generateChat } from "@/lib/llm/generate";
import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
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

// Reusable schema for the happy-path and most tests.
const VALUE_SCHEMA = z.object({ value: z.string() });

beforeEach(() => {
  vi.mocked(generateChat).mockReset();
  vi.mocked(appendMessages).mockReset();
  vi.mocked(getMessagesForScopingPass).mockReset();
  vi.mocked(getMessagesForWave).mockReset();
  vi.mocked(getNextTurnIndex).mockReset();
  vi.mocked(getMessagesForScopingPass).mockResolvedValue([]);
  vi.mocked(getMessagesForWave).mockResolvedValue([]);
  vi.mocked(getNextTurnIndex).mockResolvedValue(0);
  vi.mocked(appendMessages).mockResolvedValue([]);
});

describe("executeTurn", () => {
  it("happy path: schema validates on first attempt, writes user + assistant rows", async () => {
    vi.mocked(generateChat).mockResolvedValueOnce({
      text: '{"value":"OK_RAW"}',
      usage: FAKE_USAGE,
    });
    const result = await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hello",
      responseSchema: VALUE_SCHEMA,
    });
    expect(result.parsed).toEqual({ value: "OK_RAW" });
    expect(result.usage).toEqual(FAKE_USAGE);
    expect(appendMessages).toHaveBeenCalledOnce();
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch).toHaveLength(2);
    expect(batch[0]!.kind).toBe("user_message");
    expect(batch[1]!.kind).toBe("assistant_response");
  });

  it("retry-then-success: persists failed + directive + success rows in one batch", async () => {
    // First response fails a refine rule; second passes.
    const REFINE_SCHEMA = z
      .object({ value: z.string() })
      .refine((v) => v.value !== "BAD_VALUE", { message: "fix the thing" });

    vi.mocked(generateChat)
      .mockResolvedValueOnce({ text: '{"value":"BAD_VALUE"}', usage: FAKE_USAGE })
      .mockResolvedValueOnce({ text: '{"value":"GOOD"}', usage: FAKE_USAGE });

    const r = await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hi",
      responseSchema: REFINE_SCHEMA,
    });
    expect(r.parsed).toEqual({ value: "GOOD" });
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((b) => b.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "assistant_response",
    ]);
    // Zod's error.message includes the refine message verbatim.
    expect(batch[2]!.content).toContain("fix the thing");
  });

  it("terminal exhaust: persists failure trail and throws ValidationGateFailure", async () => {
    // Schema that always fails — the value must be "GOOD" but we always send "BAD".
    const STRICT_SCHEMA = z
      .object({ value: z.string() })
      .refine((v) => v.value === "GOOD", { message: "still broken" });

    vi.mocked(generateChat).mockResolvedValue({
      text: '{"value":"BAD"}',
      usage: FAKE_USAGE,
    });
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        responseSchema: STRICT_SCHEMA,
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

  it("wave parent: dispatches to getMessagesForWave (not scoping)", async () => {
    // `renderContext` is mocked → wave seed fields are not inspected; this
    // test verifies only the parent-kind dispatch in executeTurn.
    const WAVE_ID = "00000000-0000-0000-0000-000000000701";
    const WAVE_SEED = { kind: "wave" } as unknown as Parameters<typeof executeTurn>[0]["seed"];
    vi.mocked(generateChat).mockResolvedValueOnce({
      text: '{"value":"OK"}',
      usage: FAKE_USAGE,
    });
    await executeTurn({
      parent: { kind: "wave", id: WAVE_ID },
      seed: WAVE_SEED,
      userMessageContent: "hi",
      responseSchema: VALUE_SCHEMA,
    });
    expect(getMessagesForWave).toHaveBeenCalledWith(WAVE_ID);
    expect(getMessagesForScopingPass).not.toHaveBeenCalled();
  });

  it("transport error mid-loop: propagates without persisting", async () => {
    vi.mocked(generateChat).mockRejectedValueOnce(new Error("LLM 503"));
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        responseSchema: VALUE_SCHEMA,
      }),
    ).rejects.toThrow("LLM 503");
    expect(appendMessages).not.toHaveBeenCalled();
  });

  it("invalid JSON from model: throws ValidationGateFailure with JSON parse directive", async () => {
    // Even with strict-mode decoding, test the JSON-parse failure branch.
    vi.mocked(generateChat).mockResolvedValue({ text: "not json at all", usage: FAKE_USAGE });
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        responseSchema: VALUE_SCHEMA,
      }),
    ).rejects.toBeInstanceOf(ValidationGateFailure);
    // Should exhaust retries — all three attempts fail JSON parse.
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((b) => b.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "failed_assistant_response",
      "harness_retry_directive",
      "failed_assistant_response",
    ]);
    // Directive content should contain the JSON parse error message.
    expect(batch[2]!.content).toContain("did not parse as JSON");
  });
});
