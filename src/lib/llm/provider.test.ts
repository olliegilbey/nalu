import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v4";
import type { WaveSeedInputs } from "@/lib/types/context";
import { LLM } from "@/lib/config/tuning";

/**
 * Provider factory is thin — it reads env via `getEnv()` and wires the
 * OpenAI-compatible adapter. We verify:
 *   - It calls through to the env validator (misconfigured env surfaces).
 *   - It returns an object shape that matches a LanguageModel.
 *
 * No live API call — we never dispatch a completion here. `vi.stubEnv`
 * is used instead of mutating `process.env` directly so the functional
 * lint rules stay happy and state is auto-restored after each test.
 */

describe("getLlmModel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    vi.stubEnv("LLM_BASE_URL", "https://api.cerebras.ai/v1");
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_MODEL", "llama-3.3-70b");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?pgbouncer=true",
    );
    vi.stubEnv("DIRECT_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    vi.stubEnv("DEV_USER_ID", "00000000-0000-0000-0000-000000000000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks for token usage on streamed calls", async () => {
    // Without stream_options.include_usage an OpenAI-compatible stream may
    // end with no usage, and every streamed Step would tally 0 tokens.
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const { getLlmModel } = await import("./provider");

    await getLlmModel().doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(bodies[0]).toMatchObject({ stream_options: { include_usage: true } });
  });

  it("returns a model handle when env is valid", async () => {
    const { getLlmModel } = await import("./provider");
    const model = getLlmModel();
    // LanguageModelV3 exposes `modelId`.
    expect(model).toMatchObject({ modelId: "llama-3.3-70b" });
  });

  it("throws on missing env vars", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const { getLlmModel } = await import("./provider");
    expect(() => getLlmModel()).toThrow();
  });

  // Issue #146. The adapter spreads unknown `nalu-llm` keys into the body
  // verbatim, with no camelCase-to-snake_case mapping. These run the real
  // call paths against a stubbed fetch and read the body Cerebras gets.
  describe("prompt_cache_key on the wire", () => {
    /** An opaque Context id: a wave id or a scoping pass id. */
    const CONTEXT_ID = "22222222-2222-4222-8222-222222222222";

    /** Stubs fetch with `reply` and returns the parsed request bodies. */
    function captureRequestBodies(reply: () => Response): unknown[] {
      const bodies: unknown[] = [];
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return reply();
      });
      return bodies;
    }

    it("a structured call sends the Context's key as prompt_cache_key", async () => {
      const bodies = captureRequestBodies(() =>
        Response.json({
          id: "c1",
          created: 0,
          model: "llama-3.3-70b",
          choices: [
            { message: { role: "assistant", content: '{"x":"hi"}' }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      const { generateChat } = await import("./generate");

      await generateChat([{ role: "user", content: "hi" }], {
        responseSchema: z.object({ x: z.string() }),
        promptCacheKey: CONTEXT_ID,
      });

      expect(bodies[0]).toMatchObject({
        prompt_cache_key: CONTEXT_ID,
        reasoning_effort: LLM.reasoningEffort,
        response_format: { type: "json_schema" },
      });
      expect(bodies[0]).not.toHaveProperty("promptCacheKey");
    });

    it("a tool-loop call sends the Wave's key as prompt_cache_key", async () => {
      const chunk = (body: object): string => `data: ${JSON.stringify(body)}\n\n`;
      const bodies = captureRequestBodies(
        () =>
          new Response(
            chunk({ id: "c1", created: 0, model: "m", choices: [{ delta: { content: "Hi." } }] }) +
              chunk({
                id: "c1",
                created: 0,
                model: "m",
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const { buildWaveMidTurnAgent } = await import("@/lib/agents/waveMidTurnAgent");
      const { agent } = buildWaveMidTurnAgent({
        seed: WAVE_SEED,
        courseId: "11111111-1111-4111-8111-111111111111",
        answeredQuestionIds: [],
        waveId: CONTEXT_ID,
      });

      const result = await agent.stream({ messages: [{ role: "user", content: "hi" }] });
      for await (const part of result.fullStream) {
        void part; // drain, as executeToolTurnStream does
      }

      expect(bodies[0]).toMatchObject({
        prompt_cache_key: CONTEXT_ID,
        reasoning_effort: LLM.reasoningEffort,
        tools: expect.any(Array),
      });
      expect(bodies[0]).not.toHaveProperty("promptCacheKey");
    });
  });
});

/** A minimal Wave seed: enough to render the mid-turn agent's instructions. */
const WAVE_SEED: WaveSeedInputs = {
  kind: "wave",
  courseTopic: "Rust",
  topicScope: "Ownership",
  framework: {
    userMessage: "fw",
    estimatedStartingTier: 1,
    baselineScopeTiers: [1],
    tiers: [{ number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] }],
  },
  currentTier: 1,
  customInstructions: null,
  courseSummary: "seed",
  seedSource: {
    kind: "scoping_handoff",
    blueprint: { topic: "Ownership", outline: ["x"], openingText: "hi", plannedConcepts: [] },
  },
  dueConcepts: [],
};
