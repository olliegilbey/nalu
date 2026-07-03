import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { streamText, Output, NoObjectGeneratedError } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { toOutputSchema } from "./toCerebrasJsonSchema";

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
