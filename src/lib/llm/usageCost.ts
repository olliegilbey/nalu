/**
 * Pure token → cost math for the per-run Cerebras usage tally.
 *
 * The provider returns a `usage` object on every Step; these functions
 * turn it into a spend estimate and a summed total. All rates come from
 * `CEREBRAS_PRICING` in `tuning.ts` — nothing here hardcodes a dollar
 * figure. Cost NEVER reaches the LLM or the scoring path; this is
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
 * USD cost of token usage: `inputTokens × inputRate + outputTokens ×
 * outputRate`. Cached input tokens are DELIBERATELY not discounted —
 * Cerebras bills them at the full input rate (see the `CEREBRAS_PRICING`
 * doc + the cached-not-discounted test). Accepts any shape carrying the two
 * token counts (one Step's `LlmUsage` or a summed `UsageTotals`); undefined
 * counts coerce to zero.
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

/** Summed token counts across N Steps; `cachedInputTokens`/`reasoningTokens` are display-only. */
export interface UsageTotals {
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

/** Zero total — the identity element of {@link sumUsage}'s fold. */
const EMPTY_USAGE_TOTALS: UsageTotals = {
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

/** Field-wise sum of two {@link UsageTotals}, e.g. two smoke files' tallies. */
export function addUsageTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    steps: a.steps + b.steps,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/**
 * Immutable reduce of many Steps' usage into one {@link UsageTotals},
 * starting from `start` (default: zero). Reads the current AI SDK detail
 * fields (`inputTokenDetails.cacheReadTokens`,
 * `outputTokenDetails.reasoningTokens`) and falls back to the deprecated
 * flat fields (`cachedInputTokens`, `reasoningTokens`) so it stays correct
 * across provider usage shapes. Missing counts coerce to zero.
 */
export function sumUsage(
  usages: readonly LlmUsage[],
  start: UsageTotals = EMPTY_USAGE_TOTALS,
): UsageTotals {
  return usages.reduce<UsageTotals>(
    (acc, u) => ({
      steps: acc.steps + 1,
      inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (u.outputTokens ?? 0),
      cachedInputTokens:
        acc.cachedInputTokens + (u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0),
      reasoningTokens:
        acc.reasoningTokens + (u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? 0),
    }),
    start,
  );
}
