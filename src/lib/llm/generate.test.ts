import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v4";
import { MockLanguageModelV3 } from "ai/test";
import { generateChat } from "./generate";
import { LLM } from "@/lib/config/tuning";

// generateChat builds a Cerebras response_format only for models that honour
// strict-mode decoding (see modelCapabilities.ts). Pin a honouring model so
// the schema-wiring assertions are exercised.
beforeEach(() => {
  vi.stubEnv("LLM_MODEL", "gpt-oss-120b");
});

// vi.stubEnv does not auto-restore (the Vitest configs do not enable
// `unstubEnvs`), so restore explicitly to stop the LLM_MODEL stub leaking.
afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("sends the schema to the model as a strict json response_format", async () => {
    const model = mockModel('{"x":"hi"}');

    await generateChat([{ role: "user", content: "hi" }], {
      model,
      responseSchema: z.object({ x: z.string() }),
      responseSchemaName: "test",
    });

    // The middleware must have set callOptions.responseFormat: this is the
    // value the openai-compatible provider turns into a strict json_schema.
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
});
