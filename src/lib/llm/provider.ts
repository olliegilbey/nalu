import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getEnv } from "@/lib/config";
import type { LlmModel } from "@/lib/types/llm";

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
export function getLlmModel(): LlmModel {
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
  return provider.chatModel(env.LLM_MODEL);
}
