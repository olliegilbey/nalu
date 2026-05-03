import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
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
});
