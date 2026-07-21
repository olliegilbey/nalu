# Feature: per-run Cerebras token + cost tally (issue #25)

**Status:** specced 2026-07-20, verified absent on `main`@`f3fbc25`. Priority P2.

## Goal

Sum the `usage` object already returned on every LLM call and surface a
per-run "N tokens ≈ $X" readout. All seams the issue names still exist as
described: `ChatResult.usage` (`generate.ts:51,107,123`, type `LlmUsage =
LanguageModelUsage`), `emitSmokeFinalSnapshot`
(`src/lib/testing/smokeFinalSnapshot.ts` — currently retry-counts only),
`tuning.ts` (no pricing group).

## Design

1. **Pricing constants** → `src/lib/config/tuning.ts`, new `CEREBRAS_PRICING`
   group. Issue's May-2026 figures: input $0.35/1M, output $0.75/1M
   (reasoning tokens bill as output). **Re-verify against the Cerebras
   pricing page at implementation time** and cite source + date in the doc
   comment. ⚠️ Caching is NOT a discount on Cerebras — cached input bills at
   full input rate. `cachedInputTokens` is display-only.
2. **Pure cost function** → new `src/lib/llm/usageCost.ts` (or
   `src/lib/scoring/` if reviewers prefer; llm/ is the natural home since it
   consumes `LlmUsage`):
   - `calculateUsageCostUsd(usage: LlmUsage): number` —
     `inputTokens * inputRate + outputTokens * outputRate`, rates from
     `CEREBRAS_PRICING`. No magic numbers (warn-rule territory).
   - `sumUsage(usages: readonly LlmUsage[]): AggregatedUsage` — totals for
     calls, input, output, cached, reasoning. Immutable reduce.
   - **TDD both** (repo convention for pure algorithms), including the
     cached-not-discounted case as an explicit test.
3. **Aggregator.** Module-level accumulator in `src/lib/llm/` following the
   `cerebrasRateLimit.ts` module-state precedent: `recordUsage(usage)` called
   from `generateChat`'s return paths (`generate.ts:107,123` — both), plus
   `getRunUsageTally()` / `resetRunUsageTally()` for consumers/tests. Keep the
   `let` obvious-and-contained per conventions. Streaming path: check
   `streamChat` also surfaces usage — record there too if so.
4. **Surface.**
   - Smoke: extend `emitSmokeFinalSnapshot` to print one final line:
     `run total: N calls, X in / Y out (Z cached, R reasoning), ≈ $C`.
   - Production: per-call structured log line (stderr, matching existing
     conventions) with cumulative tally — cheap and greppable. No UI.

## Acceptance criteria (from issue)

- [ ] `just smoke` prints the final tally line.
- [ ] Pricing constants in `tuning.ts`, documented with source + date.
- [ ] Cost formula uses total input tokens (cached NOT discounted) — unit test.
- [ ] TDD for the pure cost function.

## Out of scope

Hard spend caps; rate-limiter changes; per-course DB persistence of spend.

## Files

`src/lib/config/tuning.ts`, `src/lib/llm/usageCost.ts` (+test, new),
`src/lib/llm/generate.ts` (2-line hook), `src/lib/testing/smokeFinalSnapshot.ts`.
