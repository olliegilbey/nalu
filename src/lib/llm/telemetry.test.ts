import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { APICallError, TypeValidationError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { generateChat } from "./generate";
import { llmTelemetry } from "./telemetry";

const ORIGINAL = process.env.LLM_TELEMETRY;

afterEach(() => {
  // Restore whatever the suite started with so no cross-test leakage.
  if (ORIGINAL === undefined) delete process.env.LLM_TELEMETRY;
  else process.env.LLM_TELEMETRY = ORIGINAL;
});

describe("llmTelemetry", () => {
  it("is disabled by default (flag unset)", () => {
    delete process.env.LLM_TELEMETRY;
    expect(llmTelemetry("wave-mid").isEnabled).toBe(false);
  });

  it("enables only on the exact string 'true'", () => {
    process.env.LLM_TELEMETRY = "true";
    expect(llmTelemetry("wave-mid").isEnabled).toBe(true);
    process.env.LLM_TELEMETRY = "1";
    expect(llmTelemetry("wave-mid").isEnabled).toBe(false);
  });

  it("never records inputs/outputs and carries the stage functionId", () => {
    process.env.LLM_TELEMETRY = "true";
    const t = llmTelemetry("clarify");
    // Learner content must stay out of traces — this is the invariant this
    // helper exists to centralise. Do not weaken.
    expect(t.recordInputs).toBe(false);
    expect(t.recordOutputs).toBe(false);
    expect(t.functionId).toBe("clarify");
  });
});

describe("LLM spans on a failed call (#204)", () => {
  /** Model output an error message quotes, such as an answer key. No span may hold it. */
  const SECRET = "answer-key-B-rubric-7f3a";

  /** The Context id every call here sends as its prompt cache key. */
  const CACHE_KEY = "22222222-2222-4222-8222-222222222222";

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  // Production registers the global provider in src/instrumentation.ts, and
  // the SDK's default tracer reads it. Here the global exports to memory.
  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(async () => {
    trace.disable();
    await provider.shutdown();
  });
  afterEach(() => {
    exporter.reset();
    vi.unstubAllEnvs();
  });

  // Both errors the SDK can throw with model or provider text in `message`.
  it.each([
    {
      name: "AI_TypeValidationError",
      // A response that fails its schema: the message quotes the raw value.
      error: () => new TypeValidationError({ value: { answerKey: SECRET }, cause: "bad shape" }),
    },
    {
      name: "AI_APICallError",
      // A provider rejection: the message carries the provider's own text.
      error: () =>
        new APICallError({
          message: `Bad Request: ${SECRET}`,
          url: "https://llm.test/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        }),
    },
  ])("keeps $name on the span and drops its text", async ({ name, error }) => {
    vi.stubEnv("LLM_TELEMETRY", "true");
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw error();
      },
    });

    // The thrown error itself still carries the text: callers need it.
    await expect(
      generateChat([{ role: "user", content: "hi" }], { model, promptCacheKey: CACHE_KEY }),
    ).rejects.toThrow(SECRET);

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual([
      "ai.generateText",
      "ai.generateText.doGenerate",
    ]);
    // All a span exports beyond ids and timing: attributes, events, status.
    const exported = JSON.stringify(spans.map((s) => [s.attributes, s.events, s.status]));
    expect(exported).not.toContain(SECRET);
    // Each span still says that it failed, and with which error class.
    for (const span of spans) {
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span.events.map((e) => e.attributes)).toEqual([{ "exception.type": name }]);
    }
  });
});
