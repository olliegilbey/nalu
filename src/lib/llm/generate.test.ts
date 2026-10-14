import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod/v4";
import { MockLanguageModelV3 } from "ai/test";
import { NoObjectGeneratedError } from "ai";
import { generateChat } from "./generate";
import { getRunUsageTally, resetRunUsageTally } from "./runUsageTally";
import { LLM } from "@/lib/config/tuning";

/** The Context id every call here sends as its prompt cache key. */
const CACHE_KEY = "22222222-2222-4222-8222-222222222222";

/**
 * A MockLanguageModelV3 that returns `text` and records every doGenerate
 * call into `.doGenerateCalls`. The assertions below inspect those recorded
 * call options: that is the real payload reaching the provider, after the
 * middleware has transformed the params. The doGenerate result shape follows
 * the AI SDK v6 language-model-v3 spec (see
 * node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx).
 */
function mockModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("generateChat", () => {
  // The run tally is module state; each test starts from zero.
  beforeEach(() => resetRunUsageTally());

  it("returns the model text and usage", async () => {
    const model = mockModel("hello");

    const result = await generateChat([{ role: "user", content: "hi" }], {
      model,
      promptCacheKey: CACHE_KEY,
    });

    expect(result.text).toBe("hello");
    expect(result.usage).toBeDefined();
  });

  it("applies the tuning default temperature to the model call", async () => {
    const model = mockModel("hello");

    await generateChat([{ role: "user", content: "hi" }], { model, promptCacheKey: CACHE_KEY });

    expect(model.doGenerateCalls[0]?.temperature).toBe(LLM.defaultTemperature);
  });

  it("sends reasoningEffort and the cache key under the provider-name key", async () => {
    const model = mockModel("hello");

    await generateChat([{ role: "user", content: "hi" }], { model, promptCacheKey: CACHE_KEY });

    // The openai-compatible adapter reads options under its own provider
    // name ("nalu-llm") and maps reasoningEffort -> reasoning_effort. It
    // passes prompt_cache_key through as is (wire test: provider.test.ts).
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual({
      "nalu-llm": { reasoningEffort: LLM.reasoningEffort, prompt_cache_key: CACHE_KEY },
    });
  });

  it("sends the schema to the model as a strict json response_format", async () => {
    const model = mockModel('{"x":"hi"}');

    await generateChat([{ role: "user", content: "hi" }], {
      model,
      promptCacheKey: CACHE_KEY,
      responseSchema: z.object({ x: z.string() }),
      responseSchemaName: "test",
    });

    // Output.object resolves callOptions.responseFormat from toOutputSchema:
    // this is the value the openai-compatible provider turns into a strict
    // json_schema response_format on the wire.
    const responseFormat = model.doGenerateCalls[0]?.responseFormat;
    expect(responseFormat?.type).toBe("json");
    expect(responseFormat).toMatchObject({ type: "json", name: "test" });
    expect(responseFormat).toHaveProperty("schema");
  });

  it("sets no json response_format when no schema is supplied", async () => {
    const model = mockModel("plain text");

    await generateChat([{ role: "user", content: "hi" }], { model, promptCacheKey: CACHE_KEY });

    // generateText may default responseFormat to {type:"text"} or leave it
    // unset; either way it must not be a json schema payload.
    expect(model.doGenerateCalls[0]?.responseFormat?.type).not.toBe("json");
  });

  it("returns the validated object as `parsed` when a schema is supplied", async () => {
    const model = mockModel('{"x":"hi"}');

    const result = await generateChat([{ role: "user", content: "hi" }], {
      model,
      promptCacheKey: CACHE_KEY,
      responseSchema: z.object({ x: z.string() }),
    });

    expect(result.parsed).toEqual({ x: "hi" });
    // Raw text is still returned verbatim — executeTurn persists it.
    expect(result.text).toBe('{"x":"hi"}');
  });

  it("throws NoObjectGeneratedError carrying the raw text on schema violation", async () => {
    const model = mockModel('{"x":42}'); // wrong type for x

    await expect(
      generateChat([{ role: "user", content: "hi" }], {
        model,
        promptCacheKey: CACHE_KEY,
        responseSchema: z.object({ x: z.string() }),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!NoObjectGeneratedError.isInstance(err)) return false;
      return err.text === '{"x":42}';
    });
  });

  it("folds the Step's usage into the run tally", async () => {
    await generateChat([{ role: "user", content: "hi" }], {
      model: mockModel("hello"),
      promptCacheKey: CACHE_KEY,
    });

    expect(getRunUsageTally()).toMatchObject({ steps: 1, inputTokens: 10, outputTokens: 20 });
  });

  it("folds a validation-failed Step's usage into the run tally", async () => {
    // The HTTP call succeeded and Cerebras billed it, so the tally counts it.
    await expect(
      generateChat([{ role: "user", content: "hi" }], {
        model: mockModel('{"x":42}'),
        promptCacheKey: CACHE_KEY,
        responseSchema: z.object({ x: z.string() }),
      }),
    ).rejects.toSatisfy((err: unknown) => NoObjectGeneratedError.isInstance(err));

    expect(getRunUsageTally()).toMatchObject({ steps: 1, inputTokens: 10, outputTokens: 20 });
  });
});
