import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod/v4";
import { NoObjectGeneratedError, NoOutputGeneratedError, RetryError } from "ai";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import { NO_OUTPUT_RETRY_DIRECTIVE, renderHarnessFeedback } from "@/lib/prompts/turn";
import { executeTurn } from "./executeTurn";

vi.mock("@/lib/llm/generate", () => ({
  generateChat: vi.fn(),
}));
vi.mock("@/db/queries/contextMessages.writes", () => ({
  appendMessages: vi.fn(),
}));
vi.mock("@/db/queries/contextMessages", () => ({
  getMessagesForWave: vi.fn(),
  getMessagesForScopingPass: vi.fn(),
  getNextTurnIndex: vi.fn(),
}));
// `renderContext` is exercised by its own tests; stub here so wave-seed
// fixtures don't need to be fully populated to verify dispatch logic.
vi.mock("@/lib/llm/renderContext", () => ({
  renderContext: vi.fn(() => ({ system: "SYS", messages: [] })),
}));
// Real implementation behind a spy, so tests can count schema-string builds.
vi.mock("@/lib/llm/toCerebrasJsonSchema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/toCerebrasJsonSchema")>();
  return { ...actual, toSchemaJsonString: vi.fn(actual.toSchemaJsonString) };
});

import { generateChat } from "@/lib/llm/generate";
import { renderContext } from "@/lib/llm/renderContext";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { appendMessages } from "@/db/queries/contextMessages.writes";
import {
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

/** Builds the error generateChat now throws on parse/validation failure. */
function noObjectError(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    text,
    response: { id: "test", timestamp: new Date(0), modelId: "mock" },
    usage: FAKE_USAGE,
    finishReason: "stop",
  });
}

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
  vi.mocked(toSchemaJsonString).mockClear();
  vi.mocked(renderContext).mockClear();
});

describe("executeTurn", () => {
  it("happy path: schema validates on first attempt, writes user + assistant rows", async () => {
    vi.mocked(generateChat).mockResolvedValueOnce({
      text: '{"value":"OK_RAW"}',
      parsed: { value: "OK_RAW" },
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

  // Issue #146: one prompt_cache_key per Context, so every Turn of a
  // scoping pass or a Wave routes to the same Cerebras cache.
  it.each([
    { kind: "scoping", id: SCOPING_ID },
    { kind: "wave", id: "00000000-0000-0000-0000-000000000701" },
  ] as const)("keys the prompt cache by the $kind Context's id", async (parent) => {
    vi.mocked(generateChat).mockResolvedValueOnce({
      text: '{"value":"OK"}',
      parsed: { value: "OK" },
      usage: FAKE_USAGE,
    });

    await executeTurn({
      parent,
      seed: SEED,
      userMessageContent: "hello",
      responseSchema: VALUE_SCHEMA,
    });

    expect(vi.mocked(generateChat).mock.calls[0]?.[1]).toMatchObject({
      promptCacheKey: parent.id,
    });
  });

  it("retry-then-success: persists failed + directive + success rows in one batch", async () => {
    // First response fails a refine rule; second passes.
    const REFINE_SCHEMA = z
      .object({ value: z.string() })
      .refine((v) => v.value !== "BAD_VALUE", { message: "fix the thing" });

    vi.mocked(generateChat)
      .mockRejectedValueOnce(noObjectError('{"value":"BAD_VALUE"}'))
      .mockResolvedValueOnce({
        text: '{"value":"GOOD"}',
        parsed: { value: "GOOD" },
        usage: FAKE_USAGE,
      });

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

    vi.mocked(generateChat).mockRejectedValue(noObjectError('{"value":"BAD"}'));
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

  it("schema string: never built on a first-time pass, built once across two retries", async () => {
    // First-time pass outside live mode: no reader, so no build.
    vi.mocked(generateChat).mockResolvedValueOnce({
      text: '{"value":"OK"}',
      parsed: { value: "OK" },
      usage: FAKE_USAGE,
    });
    await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hi",
      responseSchema: VALUE_SCHEMA,
    });
    expect(toSchemaJsonString).not.toHaveBeenCalled();

    // Terminal exhaust writes two directives; both reuse one build.
    vi.mocked(generateChat).mockRejectedValue(noObjectError("not json"));
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        responseSchema: VALUE_SCHEMA,
        responseSchemaName: "value",
      }),
    ).rejects.toBeInstanceOf(ValidationGateFailure);
    expect(toSchemaJsonString).toHaveBeenCalledOnce();
    expect(toSchemaJsonString).toHaveBeenCalledWith(VALUE_SCHEMA, { name: "value" });
  });

  it("live banner prints the built directive the row persists, not the raw gate detail", async () => {
    vi.stubEnv("CEREBRAS_LIVE", "1");
    // Swallow the live-smoke output; keep it for the assertion.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(generateChat).mockRejectedValue(noObjectError("not json"));
    try {
      await expect(
        executeTurn({
          parent: { kind: "scoping", id: SCOPING_ID },
          seed: SEED,
          userMessageContent: "hi",
          responseSchema: VALUE_SCHEMA,
        }),
      ).rejects.toBeInstanceOf(ValidationGateFailure);
      const printed = stderr.mock.calls.map((c) => String(c[0])).join("");
      const batch = vi.mocked(appendMessages).mock.calls[0]![0];
      // Each persisted directive line appears in the banner, indented.
      for (const line of batch[2]!.content.split("\n")) {
        expect(printed).toContain(line);
      }
      // Only the built directive says this; the raw detail does not.
      expect(printed).toContain("Here is the schema your reply must match.");
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("wave parent: dispatches to getMessagesForWave (not scoping)", async () => {
    // `renderContext` is mocked → wave seed fields are not inspected; this
    // test verifies only the parent-kind dispatch in executeTurn.
    const WAVE_ID = "00000000-0000-0000-0000-000000000701";
    const WAVE_SEED = { kind: "wave" } as unknown as Parameters<typeof executeTurn>[0]["seed"];
    vi.mocked(generateChat).mockResolvedValueOnce({
      text: '{"value":"OK"}',
      parsed: { value: "OK" },
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

  // Only the two SDK output errors spend a retry. Anything else, an SDK
  // error included, throws on attempt 1 (#191 keeps the change narrow).
  it.each([
    { name: "a plain transport error", error: new Error("LLM 503") },
    {
      name: "an SDK RetryError",
      error: new RetryError({
        message: "Failed after 7 attempts.",
        reason: "maxRetriesExceeded",
        errors: [new Error("LLM 503")],
      }),
    },
  ])("$name: propagates at once, with no retry and no rows", async ({ error }) => {
    vi.mocked(generateChat).mockRejectedValue(error);
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        responseSchema: VALUE_SCHEMA,
      }),
    ).rejects.toBe(error);
    expect(generateChat).toHaveBeenCalledOnce();
    expect(appendMessages).not.toHaveBeenCalled();
  });

  // Issue #191: a reply that is all reasoning, cut off at the provider's
  // output cap, has no text. The SDK throws NoOutputGeneratedError.
  it("no-output reply: retries, and the retry carries the fixed no-output directive", async () => {
    vi.mocked(generateChat)
      .mockRejectedValueOnce(new NoOutputGeneratedError())
      .mockResolvedValueOnce({
        text: '{"value":"GOOD"}',
        parsed: { value: "GOOD" },
        usage: FAKE_USAGE,
      });

    const r = await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hi",
      responseSchema: VALUE_SCHEMA,
    });

    expect(r.parsed).toEqual({ value: "GOOD" });
    expect(generateChat).toHaveBeenCalledTimes(2);
    const directive = renderHarnessFeedback(NO_OUTPUT_RETRY_DIRECTIVE);
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((b) => [b.kind, b.content])).toEqual([
      ["user_message", "hi"],
      // No text came back, so the failed row is empty.
      ["failed_assistant_response", ""],
      ["harness_retry_directive", directive],
      ["assistant_response", '{"value":"GOOD"}'],
    ]);
    // The second attempt's Context ends with that directive.
    const secondAttemptRows = vi.mocked(renderContext).mock.calls[1]![1];
    expect(secondAttemptRows.at(-1)).toMatchObject({
      kind: "harness_retry_directive",
      content: directive,
    });
  });

  it("no-output on every attempt: exhausts the budget and throws ValidationGateFailure", async () => {
    vi.mocked(generateChat).mockRejectedValue(new NoOutputGeneratedError());

    const failure = await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hi",
      responseSchema: VALUE_SCHEMA,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ValidationGateFailure);
    expect(failure).toMatchObject({ reason: "no_output", detail: NO_OUTPUT_RETRY_DIRECTIVE });
    expect(generateChat).toHaveBeenCalledTimes(3);
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

  it("invalid JSON from model: throws ValidationGateFailure with JSON parse directive", async () => {
    // Even with strict-mode decoding, test the JSON-parse failure branch.
    vi.mocked(generateChat).mockRejectedValue(noObjectError("not json at all"));
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
