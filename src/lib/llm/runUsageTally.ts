/**
 * Per-run Cerebras token + cost accumulator.
 *
 * WHY module state: every Step returns a `usage` object. Three places see
 * one: `generateChat`, `streamChat`, and the `onStepFinish` of each
 * `ToolLoopAgent` in `src/lib/agents/`. Each calls `recordUsage`, which
 * folds it into a process-lifetime running total. A run can then print
 * "N tokens ≈ $X" without threading usage through every call site. Same
 * module-state precedent as `cerebrasRateLimit.ts`: in-process only.
 *
 * What a "run" spans: one vitest test file in `just smoke` (vitest isolates
 * module state per file), and one warm server instance in production (many
 * requests, many courses). It is not a per-course or per-request total.
 *
 * Accumulation ALWAYS happens (so tests and the smoke snapshot can read the
 * tally); only the per-Step stderr line is gated to production + live smoke,
 * matching `cerebrasRateLimit.ts`'s activity gate, so mocked unit/integration
 * suites stay quiet.
 */

import type { LlmUsage } from "@/lib/types/llm";
import { calculateUsageCostUsd, sumUsage, type UsageTotals } from "./usageCost";

// Decimal places in the printed USD estimate. A Step costs fractions of a
// cent, so two places would round most runs to $0.00.
const COST_DECIMAL_PLACES = 4;

// --- Module-level mutable state -------------------------------------------
// A running tally is inherently stateful. Holds the summed totals, not the
// raw usages: a warm production instance records Steps for its whole life,
// so a raw list would grow without bound. `sumUsage` stays the one place
// tokens are summed.
let runTotals: UsageTotals = sumUsage([]);

/**
 * Whether to emit the per-Step stderr tally line. Mirrors
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
 * `run total: N steps, X in / Y out (Z cached, R reasoning), ≈ $C`.
 * Shared by the production stderr line and the smoke-snapshot footer so the
 * format lives in exactly one place.
 */
export function formatRunUsageTally(totals: UsageTotals): string {
  const costUsd = calculateUsageCostUsd(totals);
  return (
    `run total: ${totals.steps} steps, ${totals.inputTokens} in / ${totals.outputTokens} out ` +
    `(${totals.cachedInputTokens} cached, ${totals.reasoningTokens} reasoning), ` +
    `≈ $${costUsd.toFixed(COST_DECIMAL_PLACES)}`
  );
}

/**
 * Fold one Step's `usage` into the run total, including Steps whose output
 * failed validation (Cerebras still bills them). Emits a cumulative
 * `[llm-usage]` stderr line when {@link shouldEmitUsageLine} is true.
 */
export function recordUsage(usage: LlmUsage): void {
  runTotals = sumUsage([usage], runTotals);
  if (shouldEmitUsageLine()) {
    process.stderr.write(`[llm-usage] ${formatRunUsageTally(runTotals)}\n`);
  }
}

/** Current run total across every {@link recordUsage} call so far. */
export function getRunUsageTally(): UsageTotals {
  return runTotals;
}

/**
 * Clear the run tally. Test-only seam (each test starts clean) and available
 * to a consumer that wants per-run — rather than per-process — boundaries.
 */
export function resetRunUsageTally(): void {
  runTotals = sumUsage([]);
}
