/**
 * Shared LLM types. Thin re-exports over the Vercel AI SDK so the rest
 * of the codebase can stay provider-agnostic — nothing imports `ai`
 * directly outside `src/lib/llm/`.
 *
 * Domain-specific response schemas (framework, baseline, assessment)
 * live with their respective prompt modules, not here.
 */

import type { LanguageModel, LanguageModelUsage, ModelMessage } from "ai";

/** A single message in a chat-style exchange. */
export type LlmMessage = ModelMessage;

/** Provider-agnostic model handle produced by the provider factory. */
export type LlmModel = LanguageModel;

/** Token usage returned by every LLM call. */
export type LlmUsage = LanguageModelUsage;
