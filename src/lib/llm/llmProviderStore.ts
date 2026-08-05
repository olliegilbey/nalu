import { AsyncLocalStorage } from "node:async_hooks";

/** Selectable LLM provider ids; also the `nalu-llm-provider` cookie values. */
export type LlmProviderId = "cerebras" | "corti";

/**
 * Ambient request-scoped LLM provider selection. Mirrors `userIdStore`:
 * populated from the `nalu-llm-provider` cookie by `protectedProcedure`
 * and the wave-turn route; empty scope (smoke, scripts, background) falls
 * back to the `LLM_PROVIDER` env default via `getActiveLlmProvider`.
 */
export const llmProviderStore = new AsyncLocalStorage<LlmProviderId>();

/**
 * Active provider for the current call: request cookie if bound, else raw
 * `LLM_PROVIDER` env (default cerebras). Deliberately reads `process.env`,
 * not `getEnv()` — unit tests and CI call through here with no full env
 * configured, and a schema parse would throw; boot-time validation of
 * LLM_PROVIDER still happens in the config schema.
 */
export function getActiveLlmProvider(): LlmProviderId {
  const raw = llmProviderStore.getStore() ?? process.env.LLM_PROVIDER;
  return raw === "corti" ? "corti" : "cerebras";
}

/** Parse the `nalu-llm-provider` cookie value out of a raw Cookie header. */
export function parseLlmProviderCookie(cookieHeader: string | null): LlmProviderId | undefined {
  const match = /(?:^|;\s*)nalu-llm-provider=(cerebras|corti)(?:;|\s|$)/.exec(cookieHeader ?? "");
  return match ? (match[1] as LlmProviderId) : undefined;
}

/**
 * Run `fn` with `provider` bound to the ALS scope; when `provider` is
 * undefined (no cookie) runs `fn` unbound so the env default applies.
 */
export function runWithLlmProvider<T>(provider: LlmProviderId | undefined, fn: () => T): T {
  return provider ? llmProviderStore.run(provider, fn) : fn();
}
