/**
 * Per-run Cerebras token + cost accumulator (issue #25).
 *
 * WHY module state: every LLM call funnels through `generateChat` /
 * `streamChat`, each of which returns a `usage` object. `recordUsage` folds
 * each into a process-lifetime running total so a run (a `just smoke` pass,
 * or a production request) can print "N tokens ≈ $X" without threading usage
 * through every call site. Same module-state precedent as
 * `cerebrasRateLimit.ts` — in-process only, racy across serverless
 * invocations, correct within one.
 *
 * Accumulation ALWAYS happens (so tests and the smoke snapshot can read the
 * tally); only the per-call stderr line is gated to production + live smoke,
 * matching `cerebrasRateLimit.ts`'s activity gate, so mocked unit/integration
 * suites stay quiet.
 */

import type { LlmUsage } from "@/lib/types/llm";
import { calculateUsageCostUsd, sumUsage, type UsageTotals } from "./usageCost";

// --- Module-level mutable state -------------------------------------------
// A running tally is inherently stateful. Kept as an immutable list that
// `recordUsage` replaces (spread, never mutate) so `sumUsage` — the single
// pure fold — stays the only place tokens are summed. Call counts per run
// are small (tens), so retaining the raw usages is cheap and keeps the
// display fields (cached/reasoning) exact.
let recordedUsages: readonly LlmUsage[] = [];

/**
 * Whether to emit the per-call stderr tally line. Mirrors
 * `cerebrasRateLimit.isRateLimiterActive`: silent under plain vitest (mocked
 * suites would spam stderr), active in production (neither var set) and in
 * live smoke (`CEREBRAS_LIVE=1`). Read at call time so a harness setting the
 * vars post-import still takes effect.
 */
function shouldEmitUsageLine(): boolean {
  const underVitest = process.env.VITEST === "true" || process.env.VITEST === "1";
  return !underVitest || process.env.CEREBRAS_LIVE === "1";
}

/**
 * Human-readable one-liner for a tally:
 * `run total: N calls, X in / Y out (Z cached, R reasoning), ≈ $C`.
 * Shared by the production stderr line and the smoke-snapshot footer so the
 * format lives in exactly one place.
 */
export function formatRunUsageTally(totals: UsageTotals): string {
  const costUsd = calculateUsageCostUsd(totals);
  return (
    `run total: ${totals.calls} calls, ${totals.inputTokens} in / ${totals.outputTokens} out ` +
    `(${totals.cachedInputTokens} cached, ${totals.reasoningTokens} reasoning), ≈ $${costUsd.toFixed(4)}`
  );
}

/**
 * Fold one call's `usage` into the run total. Called from BOTH return paths
 * of `generateChat` and from `streamChat`'s `final()`. Emits a cumulative
 * `[llm-usage]` stderr line when {@link shouldEmitUsageLine} is true.
 */
export function recordUsage(usage: LlmUsage): void {
  recordedUsages = [...recordedUsages, usage];
  if (shouldEmitUsageLine()) {
    process.stderr.write(`[llm-usage] ${formatRunUsageTally(sumUsage(recordedUsages))}\n`);
  }
}

/** Current run total across every {@link recordUsage} call so far. */
export function getRunUsageTally(): UsageTotals {
  return sumUsage(recordedUsages);
}

/**
 * Clear the run tally. Test-only seam (each test starts clean) and available
 * to a consumer that wants per-run — rather than per-process — boundaries.
 */
export function resetRunUsageTally(): void {
  recordedUsages = [];
}
