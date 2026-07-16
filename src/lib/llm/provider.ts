import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";
import { getEnv } from "@/lib/config";

/**
 * Single swap-point for the underlying LLM provider.
 *
 * Uses the OpenAI-compatible adapter because our starter provider
 * (Cerebras) exposes an OpenAI Chat Completions endpoint, and so do
 * most others. Swapping to a non-compatible provider (e.g. Anthropic
 * native) is a one-line change in this file plus env vars — nothing
 * else in the codebase imports a provider package directly.
 *
 * Lazily constructed: env vars are validated on first call, not at
 * import time, so client bundles and test harnesses don't blow up.
 */
export function getLlmModel(): LanguageModelV3 {
  const env = getEnv();
  const provider = createOpenAICompatible({
    name: "nalu-llm",
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    // Provider-level flag: equivalent to model-level because this provider
    // exposes a single chat model. Enables generateObject to use the
    // JSON-schema structured-output path rather than JSON-mode fallback.
    supportsStructuredOutputs: true,
  });
  const model = provider.chatModel(env.LLM_MODEL);
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
