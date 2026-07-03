import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { streamText, Output, NoObjectGeneratedError } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { toOutputSchema } from "./toCerebrasJsonSchema";
import { streamChat } from "./streamChat";
import type { LlmMessage } from "@/lib/types/llm";

/** Mock model that streams `chunks` of text then finishes. */
function mockStreamModel(deltas: readonly string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text-1" },
          ...deltas.map((delta) => ({ type: "text-delta" as const, id: "text-1", delta })),
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            logprobs: undefined,
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 10, text: 10, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

const schema = z.object({ userMessage: z.string().min(1) });

describe("streamText + Output.object semantics (SDK behavior pin)", () => {
  it("partialOutputStream yields growing partials of the object", async () => {
    const result = streamText({
      model: mockStreamModel(['{ "userMessage": "Hel', "lo wor", 'ld" }']),
      output: Output.object({ schema: toOutputSchema(schema, { name: "t" }) }),
      prompt: "x",
    });
    const partials: unknown[] = [];
    for await (const p of result.partialOutputStream) partials.push(p);
    // Last partial contains the full message; earlier ones are prefixes.
    expect(partials.at(-1)).toEqual({ userMessage: "Hello world" });
    expect(await result.output).toEqual({ userMessage: "Hello world" });
  });

  it("output promise rejects with NoObjectGeneratedError on schema violation", async () => {
    const result = streamText({
      model: mockStreamModel(['{ "wrong": true }']),
      output: Output.object({ schema: toOutputSchema(schema, { name: "t" }) }),
      prompt: "x",
    });
    // Drain partials first (route code will too).
    for await (const _ of result.partialOutputStream) {
      /* drain */
    }
    await expect(result.output).rejects.toSatisfy((e: unknown) =>
      NoObjectGeneratedError.isInstance(e),
    );
  });
});

const messages: readonly LlmMessage[] = [{ role: "user", content: "hi" }];

describe("streamChat", () => {
  it("yields partials and resolves final parsed + text + usage", async () => {
    const handle = await streamChat(messages, {
      model: mockStreamModel(['{ "userMessage": "Hi!" }']),
      responseSchema: schema,
      responseSchemaName: "t",
    });
    const partials: unknown[] = [];
    for await (const p of handle.partialOutputStream) partials.push(p);
    const final = await handle.final();
    expect(final.parsed).toEqual({ userMessage: "Hi!" });
    expect(final.text).toBe('{ "userMessage": "Hi!" }');
    expect(final.usage).toBeDefined();
    expect(partials.length).toBeGreaterThan(0);
  });

  it("final() rejects with NoObjectGeneratedError on invalid output", async () => {
    const handle = await streamChat(messages, {
      model: mockStreamModel(['{ "wrong": 1 }']),
      responseSchema: schema,
      responseSchemaName: "t",
    });
    for await (const _ of handle.partialOutputStream) {
      /* drain */
    }
    await expect(handle.final()).rejects.toSatisfy((e: unknown) =>
      NoObjectGeneratedError.isInstance(e),
    );
  });
});
