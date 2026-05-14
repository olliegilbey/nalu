import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod/v4";

// Mock the `ai` module so we never dispatch real network calls. We
// assert wiring: defaults applied, responseFormat threaded, usage propagated.
const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (args: unknown) => generateTextMock(args),
}));

// Stub the provider so we don't need env vars wired.
vi.mock("./provider", () => ({
  getLlmModel: () => ({ __stub: "model" }),
}));

import { generateChat } from "./generate";
import { LLM } from "@/lib/config/tuning";

// Ensure tests run against a model that honours strict-mode so responseFormat
// assertions are meaningful. `vi.stubEnv` is the idiomatic Vitest approach —
// no mutable let, automatically restored between tests.
beforeEach(() => {
  vi.stubEnv("LLM_MODEL", "llama-3.3-70b");
});

describe("generateChat", () => {
  it("returns text + usage from generateText", async () => {
    const usage = { inputTokens: 5, outputTokens: 2, totalTokens: 7 };
    generateTextMock.mockResolvedValueOnce({ text: "hello", usage });

    const result = await generateChat([{ role: "user", content: "hi" }]);

    expect(result).toEqual({ text: "hello", usage });
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: LLM.defaultTemperature,
        maxRetries: LLM.maxRetries,
      }),
    );
  });

  it("passes responseSchema through as responseFormat with type json", async () => {
    // Verify that when responseSchema is supplied, generateText receives
    // responseFormat: { type: "json", name, schema } from toCerebrasJsonSchema.
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    generateTextMock.mockResolvedValueOnce({ text: '{"x":"hi"}', usage });

    const schema = z.object({ x: z.string() });
    await generateChat([{ role: "user", content: "hi" }], {
      responseSchema: schema,
      responseSchemaName: "test",
    });

    // at(-1) avoids an index-possibly-undefined error without non-null assertions.
    const capturedArgs = generateTextMock.mock.calls.at(-1)?.[0];
    // Must carry a responseFormat that satisfies the Cerebras wire shape.
    expect(capturedArgs.responseFormat).toMatchObject({ type: "json", name: "test" });
    expect(capturedArgs.responseFormat.schema).toBeDefined();
  });

  it("omits responseFormat when no responseSchema supplied", async () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    generateTextMock.mockResolvedValueOnce({ text: "plain text", usage });

    await generateChat([{ role: "user", content: "hi" }]);

    // at(-1) avoids an index-possibly-undefined error without non-null assertions.
    const capturedArgs = generateTextMock.mock.calls.at(-1)?.[0];
    // responseFormat must NOT be present when no schema given.
    expect(capturedArgs.responseFormat).toBeUndefined();
  });
});
