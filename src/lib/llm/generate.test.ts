import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";
import { MockLanguageModelV3 } from "ai/test";
import { NoObjectGeneratedError } from "ai";
import { generateChat } from "./generate";
import { LLM } from "@/lib/config/tuning";

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
  it("returns the model text and usage", async () => {
    const model = mockModel("hello");

    const result = await generateChat([{ role: "user", content: "hi" }], { model });

    expect(result.text).toBe("hello");
    expect(result.usage).toBeDefined();
  });

  it("applies the tuning default temperature to the model call", async () => {
    const model = mockModel("hello");

    await generateChat([{ role: "user", content: "hi" }], { model });

    expect(model.doGenerateCalls[0]?.temperature).toBe(LLM.defaultTemperature);
  });

  it("sends reasoningEffort under the provider-name key so it reaches the wire", async () => {
    const model = mockModel("hello");

    await generateChat([{ role: "user", content: "hi" }], { model });

    // The openai-compatible adapter reads options under its own provider
    // name ("nalu-llm") and maps reasoningEffort -> reasoning_effort.
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual({
      "nalu-llm": { reasoningEffort: LLM.reasoningEffort },
    });
  });

  it("sends the schema to the model as a strict json response_format", async () => {
    const model = mockModel('{"x":"hi"}');

    await generateChat([{ role: "user", content: "hi" }], {
      model,
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

    await generateChat([{ role: "user", content: "hi" }], { model });

    // generateText may default responseFormat to {type:"text"} or leave it
    // unset; either way it must not be a json schema payload.
    expect(model.doGenerateCalls[0]?.responseFormat?.type).not.toBe("json");
  });

  it("returns the validated object as `parsed` when a schema is supplied", async () => {
    const model = mockModel('{"x":"hi"}');

    const result = await generateChat([{ role: "user", content: "hi" }], {
      model,
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
        responseSchema: z.object({ x: z.string() }),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!NoObjectGeneratedError.isInstance(err)) return false;
      return err.text === '{"x":42}';
    });
  });

  it("sends response_format regardless of model capability (gate removed)", async () => {
    // Pre-Output behavior gated response_format on honorsStrictMode; the gate
    // is gone — Cerebras treats response_format as soft guidance, so sending
    // it universally is harmless and keeps one code path.
    vi.stubEnv("LLM_MODEL", "llama3.1-8b"); // a non-honouring model name
    const model = mockModel('{"x":"hi"}');

    await generateChat([{ role: "user", content: "hi" }], {
      model,
      responseSchema: z.object({ x: z.string() }),
    });

    expect(model.doGenerateCalls[0]?.responseFormat?.type).toBe("json");
    vi.unstubAllEnvs();
  });
});
