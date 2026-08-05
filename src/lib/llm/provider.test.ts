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
    // Pin provider selection: `bun run test` loads .env.local, whose
    // LLM_PROVIDER=corti + CORTI_* credentials would otherwise leak in.
    vi.stubEnv("LLM_PROVIDER", "cerebras");
    vi.stubEnv("CORTI_API_KEY", undefined);
    vi.stubEnv("CORTI_TENANT_NAME", undefined);
    vi.stubEnv("CORTI_CLIENT_ID", undefined);
    vi.stubEnv("CORTI_CLIENT_SECRET", undefined);
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

  it("returns the corti model when LLM_PROVIDER=corti with client credentials", async () => {
    vi.stubEnv("LLM_PROVIDER", "corti");
    vi.stubEnv("CORTI_TENANT_NAME", "tenant");
    vi.stubEnv("CORTI_CLIENT_ID", "client");
    vi.stubEnv("CORTI_CLIENT_SECRET", "secret");
    const { getLlmModel, getActiveModelName } = await import("./provider");
    expect(getLlmModel()).toMatchObject({ modelId: "corti-s1" });
    expect(getActiveModelName()).toBe("corti-s1");
  });

  it("throws a descriptive error when corti is selected without credentials", async () => {
    vi.stubEnv("LLM_PROVIDER", "corti");
    const { getLlmModel } = await import("./provider");
    expect(() => getLlmModel()).toThrow(/CORTI_API_KEY/);
  });

  it("cookie-scoped provider overrides the env default", async () => {
    // Env default stays cerebras; a request-scoped ALS binding picks corti.
    vi.stubEnv("CORTI_API_KEY", "test-bearer");
    const { getLlmModel } = await import("./provider");
    const { runWithLlmProvider } = await import("./llmProviderStore");
    const model = runWithLlmProvider("corti", () => getLlmModel());
    expect(model).toMatchObject({ modelId: "corti-s1" });
  });
});
