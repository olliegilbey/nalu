/**
 * Pure token → cost math for the per-run Cerebras usage tally (issue #25).
 *
 * The provider already returns a `usage` object on every LLM call; these
 * functions turn it into a spend estimate and a summed total. All rates
 * come from `CEREBRAS_PRICING` in `tuning.ts` — nothing here hardcodes a
 * dollar figure. Cost NEVER reaches the LLM or the scoring path; this is
 * observability only.
 */

import { CEREBRAS_PRICING } from "@/lib/config/tuning";
import type { LlmUsage } from "@/lib/types/llm";

// One million — the denominator of the "USD per MILLION tokens" pricing
// unit. Named so the rate derivation reads as a unit conversion, not a
// magic literal.
const TOKENS_PER_MILLION = 1_000_000;

// Per-token USD rates, derived once from the tunable. Reasoning tokens are
// already folded into `outputTokens` by the AI SDK, so charging output
// tokens at this rate captures reasoning spend automatically.
const INPUT_USD_PER_TOKEN = CEREBRAS_PRICING.inputUsdPerMillionTokens / TOKENS_PER_MILLION;
const OUTPUT_USD_PER_TOKEN = CEREBRAS_PRICING.outputUsdPerMillionTokens / TOKENS_PER_MILLION;

/**
 * USD cost of a single call's usage: `inputTokens × inputRate +
 * outputTokens × outputRate`. Cached input tokens are DELIBERATELY not
 * discounted — Cerebras bills them at the full input rate (see the
 * `CEREBRAS_PRICING` doc + the cached-not-discounted test). Accepts any
 * shape carrying the two token counts (an `LlmUsage` or a summed
 * `UsageTotals`); undefined counts coerce to zero.
 */
export function calculateUsageCostUsd(usage: {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
}): number {
  return (
    (usage.inputTokens ?? 0) * INPUT_USD_PER_TOKEN +
    (usage.outputTokens ?? 0) * OUTPUT_USD_PER_TOKEN
  );
}

/** Summed token counts across N LLM calls; `cachedInputTokens`/`reasoningTokens` are display-only. */
export interface UsageTotals {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

/** Zero total — the identity element of {@link sumUsage}'s fold. */
const EMPTY_USAGE_TOTALS: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

/**
 * Immutable reduce of many calls' usage into one {@link UsageTotals}.
 * Reads the current AI SDK detail fields (`inputTokenDetails.cacheReadTokens`,
 * `outputTokenDetails.reasoningTokens`) and falls back to the deprecated
 * flat fields (`cachedInputTokens`, `reasoningTokens`) so it stays correct
 * across provider usage shapes. Missing counts coerce to zero.
 */
export function sumUsage(usages: readonly LlmUsage[]): UsageTotals {
  return usages.reduce<UsageTotals>(
    (acc, u) => ({
      calls: acc.calls + 1,
      inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (u.outputTokens ?? 0),
      cachedInputTokens:
        acc.cachedInputTokens + (u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0),
      reasoningTokens:
        acc.reasoningTokens + (u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? 0),
    }),
    EMPTY_USAGE_TOTALS,
  );
}
