/**
 * Cerebras token + cost accumulator.
 *
 * WHY module state: every Step returns a `usage` object, and
 * `recordStepFinished` hands each one to `recordUsage`, which folds it into
 * a running total. A run can then print "N tokens ≈ $X" without threading
 * usage through every call site. Same module-state precedent as
 * `cerebrasRateLimit.ts`: in-process only.
 *
 * What the total spans, exactly:
 * - **One `just smoke` run.** Vitest gives each test file its own module
 *   state, so each live file keeps its own total. The live project's
 *   global setup (`src/lib/testing/smokeUsageTotal.globalSetup.ts`) sums
 *   them and prints one line at the end of the run.
 * - **One warm server instance in production.** That covers many requests
 *   and many courses. It is not a per-course or per-request total.
 *
 * Gap: a tool-loop Step aborted mid-stream (client disconnect, transport
 * error) is billed by Cerebras but not counted, because `onStepFinish`
 * never fires for it.
 *
 * Accumulation ALWAYS happens (so tests and the smoke total can read it);
 * only the per-Step stderr line is gated, by the rate limiter's own check.
 */

import type { LlmUsage } from "@/lib/types/llm";
import { isRateLimiterActive } from "./cerebrasRateLimit";
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
 * Human-readable one-liner for a tally:
 * `N steps, X in / Y out (Z cached, R reasoning), ≈ $C`. Shared by the
 * per-Step stderr line and the smoke-run total, so the format lives in
 * exactly one place; callers add their own label.
 */
export function formatUsageTotals(totals: UsageTotals): string {
  const costUsd = calculateUsageCostUsd(totals);
  return (
    `${totals.steps} steps, ${totals.inputTokens} in / ${totals.outputTokens} out ` +
    `(${totals.cachedInputTokens} cached, ${totals.reasoningTokens} reasoning), ` +
    `≈ $${costUsd.toFixed(COST_DECIMAL_PLACES)}`
  );
}

/**
 * Fold one Step's `usage` into the running total. Prints a cumulative
 * `[llm-usage]` stderr line wherever the rate limiter paces: production and
 * live smoke, never mocked suites.
 */
export function recordUsage(usage: LlmUsage): void {
  runTotals = sumUsage([usage], runTotals);
  if (isRateLimiterActive()) {
    process.stderr.write(`[llm-usage] cumulative: ${formatUsageTotals(runTotals)}\n`);
  }
}

/** Running total across every {@link recordUsage} call in this module instance. */
export function getRunUsageTally(): UsageTotals {
  return runTotals;
}

/**
 * Clear the running total. Test-only seam (each test starts clean) and
 * available to a consumer that wants narrower boundaries than the module's.
 */
export function resetRunUsageTally(): void {
  runTotals = sumUsage([]);
}
