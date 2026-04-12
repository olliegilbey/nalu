import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

// Mock the `ai` module so we never dispatch real network calls. We
// assert wiring: schema forwarded, defaults applied, usage propagated.
const generateObjectMock = vi.fn();
const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
  generateText: (args: unknown) => generateTextMock(args),
}));

// Stub the provider so we don't need env vars wired.
vi.mock("./provider", () => ({
  getLlmModel: () => ({ __stub: "model" }),
}));

import { generateStructured, generateChat } from "./generate";
import { LLM } from "@/lib/config/tuning";

describe("generateStructured", () => {
  it("forwards schema, messages, and defaults; returns object + usage", async () => {
    const schema = z.object({ answer: z.string() });
    const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13 };
    generateObjectMock.mockResolvedValueOnce({
      object: { answer: "ok" },
      usage,
    });

    const result = await generateStructured(schema, [{ role: "user", content: "hi" }]);

    expect(result).toEqual({ object: { answer: "ok" }, usage });
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        schema,
        temperature: LLM.defaultTemperature,
        maxRetries: LLM.maxRetries,
      }),
    );
  });

  it("honours per-call temperature override", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {},
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    await generateStructured(z.object({}), [], { temperature: 0.9 });
    expect(generateObjectMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ temperature: 0.9 }),
    );
  });

  it("surfaces SDK errors", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("validation failed"));
    await expect(generateStructured(z.object({ a: z.string() }), [])).rejects.toThrow(
      "validation failed",
    );
  });
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
});
