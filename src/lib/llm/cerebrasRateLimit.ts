import { LLM } from "@/lib/config/tuning";
import { userIdStore } from "./userIdStore";

/**
 * Header-aware Cerebras rate limiter for the entire application.
 *
 * WHY: every LLM call funnels through `generateChat` → `generateText`.
 * Cerebras's FREE tier caps at 5 requests/min (a 12.0s floor), 30,000
 * tokens/min, 1M tokens/hour, and 1M tokens/day. Exceeding any → HTTP 429.
 * The turn runner `executeTurn` validates each model reply and RETRIES on
 * a schema failure — each retry is another back-to-back `generateChat`
 * call. A flaky model expands one logical turn into 2–6 actual API calls
 * (steps/retries) in a tight burst, which blows past the provider request
 * budget → 429 → the AI SDK exhausts its transport-retry budget →
 * `AI_RetryError`. This module paces at that single chokepoint so every
 * actual API call (including retry-burst calls) is throttled.
 *
 * It also reads Cerebras's `x-ratelimit-*` response headers, which report
 * the ACCOUNT-WIDE remaining budget. The same API key is shared with another
 * workload, so the token-budget backoff here absorbs that contention
 * automatically — Nalu waits when the shared bucket runs low.
 *
 * LIMITATION: Cerebras reports token budget only per-MINUTE
 * (`x-ratelimit-*-tokens-minute`); there is NO per-day token header. So this
 * limiter cannot see — and does not enforce — the 1M tokens/DAY cap.
 * Exhausting it across repeated smoke runs still yields a hard 429
 * ("Tokens per day limit exceeded"). Enforcing TPD would need cumulative
 * `usage` accounting in a persistent cross-process store (future work).
 *
 * Per-user fast/slow lane: each call reads the active userId from
 * `userIdStore` (Node AsyncLocalStorage, populated by `protectedProcedure`
 * in `src/server/trpc.ts`). The first `LLM.fastLaneCallsPerUser` calls per
 * userId use `LLM.fastLaneSpacingMs` (200ms); calls beyond that fall back
 * to `LLM.slowLaneSpacingMs` (13s). Calls with no userId in scope (smoke,
 * CLI, background) use the fast lane and do not consume any user's budget.
 * The counter is in-memory only (`callCountByUser`); cold starts reset it.
 *
 * Two responsibilities, both consumed by `generateChat`:
 *   - `awaitCerebrasCallSlot()` — BEFORE `generateText`: enforces request
 *     spacing AND token-budget backoff.
 *   - `recordCerebrasRateLimitHeaders(headers)` — AFTER `generateText`:
 *     captures the `x-ratelimit-*` headers for the next call to consult.
 *
 * Gating: active in PRODUCTION and LIVE SMOKE (`CEREBRAS_LIVE=1`); a complete
 * no-op in mocked unit/integration suites (where a 13s wait would hang the
 * run). See `isRateLimiterActive` for the exact condition.
 *
 * State scope: module-level mutable state, in-process only. No mutex, no
 * shared store, no DB. This is racy ACROSS Vercel serverless invocations —
 * a deliberate, accepted limitation for now (a shared-store version is
 * explicit future work). It is perfectly correct WITHIN one invocation,
 * which is exactly where `executeTurn`'s retry burst happens.
 */

/**
 * Whether the rate limiter should actually pace calls.
 *
 * WHY: mocked unit/integration suites must no-op the limiter — a 13s wait
 * would hang the run. Vitest sets `process.env.VITEST` for every project,
 * so we treat "under vitest" as inert UNLESS the live-smoke project opted
 * in with `CEREBRAS_LIVE=1`. Production sets neither var, so it stays
 * active there. Env is read at CALL time (not module-load) so a harness
 * that sets the vars after import still takes effect.
 */
function isRateLimiterActive(): boolean {
  const underVitest = process.env.VITEST === "true" || process.env.VITEST === "1";
  return !underVitest || process.env.CEREBRAS_LIVE === "1";
}

// --- Module-level mutable state -------------------------------------------
// A rate limiter is inherently stateful: it must remember the previous
// call's dispatch time and the last-seen token budget. This is the one
// honest exception to `eslint-plugin-functional`'s `no-let` rule.

/**
 * Dispatch timestamp (ms epoch) of the previous LLM call. Initialised to 0
 * so the first call in any process is never delayed by request spacing.
 */
let lastDispatchAtMs = 0;

/**
 * Absolute time (ms epoch) at which the per-minute token bucket is expected
 * to refill, OR `null` if no rate-limit headers have been seen yet (first
 * call, or Cerebras omitted them). Computed at record-time from the
 * `x-ratelimit-reset-tokens-minute` header, which Cerebras sends as
 * SECONDS-UNTIL-RESET (a floating-point number, e.g. `11.38`).
 */
let tokenBucketResetAtMs: number | null = null;

/**
 * Last-seen `x-ratelimit-remaining-tokens-minute` value, OR `null` if no
 * headers have been observed yet. When this drops below
 * `LLM.lowTokenBudgetThreshold`, the next acquire waits for the bucket reset.
 */
let remainingTokensThisMinute: number | null = null;

/**
 * Per-user call counter, keyed by userId. Each entry counts how many LLM
 * calls this user has made in the current process lifetime. When the count
 * reaches `LLM.fastLaneCallsPerUser`, the next call (and all subsequent
 * ones) use `LLM.slowLaneSpacingMs` instead of `LLM.fastLaneSpacingMs`.
 *
 * In-memory only — no DB, no shared store. Cold starts reset the map, which
 * is generous to the user (they get another fast-lane window) and does not
 * affect wallet exposure (~$0.10/session regardless). See the spec at
 * `docs/superpowers/specs/2026-05-26-per-user-rate-limit-fast-lane-design.md`
 * for the rationale.
 *
 * No userId in scope (smoke runs, CLI, background) → the limiter uses the
 * fast lane and does not mutate this map. The Map's `get` returns undefined
 * for unknown keys, which we coerce to 0.
 */
const callCountByUser = new Map<string, number>();

/**
 * Sleep for `ms` milliseconds. Extracted so the wait sites read cleanly and
 * vitest fake timers have a single `setTimeout` to drive.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until this call is cleared to dispatch under the Cerebras rate
 * limits, then record its dispatch time.
 *
 * Two gates, applied in order:
 *   1. Token-budget backoff — if the last-seen remaining per-minute token
 *      budget is below `LLM.lowTokenBudgetThreshold`, wait until the stored
 *      bucket-reset time. Skipped when no headers have been seen yet.
 *   2. Request spacing — wait so this dispatch is ≥ the per-user lane's
 *      spacing (`LLM.fastLaneSpacingMs` for the first `fastLaneCallsPerUser`
 *      calls, then `LLM.slowLaneSpacingMs` — the 5-RPM floor) after the
 *      previous one.
 *
 * A complete no-op (returns immediately) when `isRateLimiterActive()` is
 * false — i.e. in mocked unit/integration test suites.
 *
 * @returns A promise that resolves once this call is cleared to dispatch.
 */
export async function awaitCerebrasCallSlot(): Promise<void> {
  // Gate: outside production / live smoke this does nothing at all.
  if (!isRateLimiterActive()) return;

  // Resolve the per-user lane. No userId in scope → fast lane, no counter
  // mutation. The lane choice is per-user; the spacing gate itself is
  // global (a single dispatch clock for the process).
  const userId = userIdStore.getStore();
  const count = userId !== undefined ? (callCountByUser.get(userId) ?? 0) : 0;
  const spacingMs =
    count < LLM.fastLaneCallsPerUser ? LLM.fastLaneSpacingMs : LLM.slowLaneSpacingMs;

  // Gate 1 — token-budget backoff. Only when we've seen headers AND the
  // last-reported remaining budget is too low to safely cover one more
  // large turn. We wait out the bucket-reset window stored at record-time.
  if (
    remainingTokensThisMinute !== null &&
    remainingTokensThisMinute < LLM.lowTokenBudgetThreshold &&
    tokenBucketResetAtMs !== null
  ) {
    const tokenWaitMs = tokenBucketResetAtMs - Date.now();
    if (tokenWaitMs > 0) {
      await sleep(tokenWaitMs);
    }
  }

  // Gate 2 — request spacing. Wait the remainder of the chosen spacing
  // window since the previous dispatch. Negative/zero when enough time
  // has passed (or when this is the first call in the process).
  const spacingWaitMs = spacingMs - (Date.now() - lastDispatchAtMs);
  if (spacingWaitMs > 0) {
    await sleep(spacingWaitMs);
  }

  // Record this call's dispatch time AFTER any waits, so it reflects the
  // moment the call is actually cleared to fire (call-start to call-start).
  lastDispatchAtMs = Date.now();

  // Increment the per-user counter ONLY when a userId is in scope. Calls
  // outside a tRPC request (smoke / CLI / background) don't consume any
  // user's fast-lane budget. Re-read at increment time so concurrent
  // calls that interleaved with our `await` above don't lose increments
  // — `get`+`set` within one synchronous frame is atomic in Node's
  // single-threaded event loop (the documented lane-choice race at the
  // top of this function still stands; this only fixes lost updates).
  if (userId !== undefined) {
    const current = callCountByUser.get(userId) ?? 0;
    callCountByUser.set(userId, current + 1);
  }
}

/**
 * Parse the Cerebras `x-ratelimit-*` headers from an LLM response and store
 * the per-minute token budget for the next `awaitCerebrasCallSlot()` to
 * consult.
 *
 * Headers consumed:
 *   - `x-ratelimit-remaining-tokens-minute` — a number (tokens left this min).
 *   - `x-ratelimit-reset-tokens-minute` — SECONDS-UNTIL-RESET, floating point
 *     (confirmed from Cerebras docs, e.g. `11.382867097854614`). Converted
 *     here to an absolute ms-epoch wake time so `awaitCerebrasCallSlot` can
 *     compare it against `Date.now()` later without re-reading the header.
 *
 * Defensive parsing: headers may be absent on the very first call, or if
 * Cerebras omits them, or if a future format change makes them
 * unparseable. In any of those cases the stored state is left untouched
 * (or stays `null`) so the next acquire simply skips the token gate and
 * applies request spacing only. A non-active limiter ignores headers
 * entirely.
 *
 * @param headers - The `result.response.headers` map from the AI SDK's
 *   `generateText` result, or `undefined` if the provider exposed none.
 */
export function recordCerebrasRateLimitHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): void {
  // No work to do when the limiter is inert or no headers were returned.
  if (!isRateLimiterActive() || headers === undefined) return;

  // Header keys are lower-cased by the AI SDK / fetch; read them directly.
  const remainingRaw = headers["x-ratelimit-remaining-tokens-minute"];
  const resetRaw = headers["x-ratelimit-reset-tokens-minute"];

  // Both headers must be present and parse to finite numbers; otherwise we
  // leave prior state alone rather than corrupt it with NaN.
  const remaining = remainingRaw !== undefined ? Number(remainingRaw) : NaN;
  const resetSeconds = resetRaw !== undefined ? Number(resetRaw) : NaN;
  if (!Number.isFinite(remaining) || !Number.isFinite(resetSeconds)) return;

  remainingTokensThisMinute = remaining;
  // Cerebras sends reset as seconds-until-reset; convert to an absolute
  // ms-epoch deadline so later comparisons need no header re-read.
  tokenBucketResetAtMs = Date.now() + resetSeconds * 1000;
}

/**
 * Reset all module state. Test-only seam — production never calls this.
 * Lets each unit test start from a clean slate (no dispatch history, no
 * token budget) regardless of execution order.
 */
export function __resetCerebrasRateLimitStateForTests(): void {
  lastDispatchAtMs = 0;
  tokenBucketResetAtMs = null;
  remainingTokensThisMinute = null;
  callCountByUser.clear();
}
