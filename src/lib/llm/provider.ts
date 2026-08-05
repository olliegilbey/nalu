import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";
import { getEnv } from "@/lib/config";
import { LLM } from "@/lib/config/tuning";
import { getActiveLlmProvider, llmProviderStore } from "./llmProviderStore";

/**
 * Per-call `providerOptions` for every LLM call: sets `reasoning_effort` on
 * the wire (tuning `LLM.reasoningEffort`). The outer key MUST match the
 * provider `name` below — the openai-compatible adapter looks up options
 * under its own name and merges unknown keys into the request body.
 * Deliberately keyed to "nalu-llm" (Cerebras) only: the Corti provider is
 * named "nalu-corti", so this option never reaches Corti's API — whether
 * corti-s1 accepts `reasoning_effort` is unverified, and reasoning depth is
 * selected there by model variant (`-instant`) rather than a parameter.
 */
export function llmProviderOptions(): Record<string, Record<string, string>> {
  return { "nalu-llm": { reasoningEffort: LLM.reasoningEffort } };
}

/**
 * Model name string for the ACTIVE provider (cookie/env selected) — the key
 * used for `getModelCapabilities` lookups. corti-s1 is deliberately absent
 * from the capabilities registry: the 2026-08-05 probe showed Corti silently
 * drops `response_format`, so the unknown-model path (inline
 * `<response_schema>`) is the correct one.
 *
 * Reads raw `process.env` (not `getEnv()`): course-step unit tests call this
 * with no env configured, and a full schema parse would throw there. This is
 * a lookup key with fallbacks, not validated config — mirrors the previous
 * `process.env.LLM_MODEL ?? "(default)"` behaviour at the call sites.
 */
export function getActiveModelName(): string {
  const active = llmProviderStore.getStore() ?? process.env.LLM_PROVIDER ?? "cerebras";
  return active === "corti"
    ? (process.env.CORTI_MODEL ?? "corti-s1")
    : (process.env.LLM_MODEL ?? "(default)");
}

/**
 * Corti bearer for the OpenAI-compatible endpoint: explicit CORTI_API_KEY if
 * set, else derived from the console's client-credential trio using the same
 * construction @corti/cli writes into coding-agent configs:
 * base64("<tenant>:client_credentials:<client_id>:<client_secret>").
 */
function resolveCortiApiKey(env: ReturnType<typeof getEnv>): string {
  if (env.CORTI_API_KEY) return env.CORTI_API_KEY;
  if (env.CORTI_TENANT_NAME && env.CORTI_CLIENT_ID && env.CORTI_CLIENT_SECRET) {
    return Buffer.from(
      `${env.CORTI_TENANT_NAME}:client_credentials:${env.CORTI_CLIENT_ID}:${env.CORTI_CLIENT_SECRET}`,
    ).toString("base64");
  }
  throw new Error(
    "The corti LLM provider is selected (LLM_PROVIDER env or nalu-llm-provider " +
      "cookie) but neither CORTI_API_KEY nor the CORTI_TENANT_NAME / " +
      "CORTI_CLIENT_ID / CORTI_CLIENT_SECRET trio is set in the environment.",
  );
}

/**
 * Single swap-point for the underlying LLM provider, selected per request
 * via `getActiveLlmProvider()` (cookie/ALS, else LLM_PROVIDER env).
 *
 * Uses the OpenAI-compatible adapter for both providers: Cerebras and
 * Corti each expose an OpenAI Chat Completions endpoint. Nothing else in
 * the codebase imports a provider package directly.
 *
 * Lazily constructed: env vars are validated on first call, not at
 * import time, so client bundles and test harnesses don't blow up.
 */
export function getLlmModel(): LanguageModelV3 {
  const env = getEnv();
  const active = getActiveLlmProvider();
  const provider =
    active === "corti"
      ? createOpenAICompatible({
          // Distinct name: keeps the "nalu-llm"-keyed providerOptions
          // (reasoning_effort) from being merged into Corti requests.
          name: "nalu-corti",
          baseURL: env.CORTI_BASE_URL,
          apiKey: resolveCortiApiKey(env),
          // Sent optimistically; whether Corti enforces strict json_schema is
          // unverified, so the capabilities layer ALSO sends the inline
          // schema (corti models are unknown → honorsStrictMode false), and
          // Zod validate-and-retry remains the real safety net either way.
          supportsStructuredOutputs: true,
        })
      : createOpenAICompatible({
          name: "nalu-llm",
          baseURL: env.LLM_BASE_URL,
          apiKey: env.LLM_API_KEY,
          // Provider-level flag: equivalent to model-level because this provider
          // exposes a single chat model. Enables generateObject to use the
          // JSON-schema structured-output path rather than JSON-mode fallback.
          supportsStructuredOutputs: true,
        });
  const model = provider.chatModel(active === "corti" ? env.CORTI_MODEL : env.LLM_MODEL);
  // DevTools capture is development-only: the middleware writes every
  // request/response (learner content + grading keys included) to
  // .devtools/generations.json for the local viewer (`just llm-devtools`).
  // Double-gated — NODE_ENV must be development AND `LLM_DEVTOOLS=1` must be
  // set explicitly — so it can never activate in production and `just dev`
  // opts in per run rather than always paying the overhead. The package sits
  // in `dependencies` (not dev): this static import must resolve in pruned
  // production installs even though the wrapper never activates there.
  // Docs: node_modules/ai/docs/03-ai-sdk-core/65-devtools.mdx
  if (process.env.NODE_ENV === "development" && process.env.LLM_DEVTOOLS === "1") {
    // Every published @ai-sdk/devtools types its middleware against provider
    // spec V4 while this stack (ai@6.0.158) is V3. The middleware hook shape
    // (transformParams/wrapGenerate/wrapStream) is structurally identical and
    // capture was verified live 2026-07-16 (.devtools/generations.json
    // written, calls unaffected). Dev-only code path. Drop this cast when the
    // ai/provider major bump lands.
    const middleware = devToolsMiddleware() as unknown as LanguageModelV3Middleware;
    return wrapLanguageModel({ model, middleware });
  }
  return model;
}
