import { LLM } from "@/lib/config/tuning";

/**
 * Live-smoke call-site pacing for Cerebras free-tier rate limits.
 *
 * WHY: Cerebras free tier caps at ~30 RPM (≈2s minimum spacing between
 * requests). The smoke suite (`*.live.test.ts`, gated on `CEREBRAS_LIVE=1`)
 * fires many LLM calls quasi-serially. The earlier approach paced logical
 * *turns* in the test helpers — but one turn is NOT one API call.
 * `executeTurn` validates the model's JSON reply and, on a schema failure,
 * RETRIES: each retry fires another `generateChat` → `generateText` call,
 * back-to-back with no pacing. A flaky model turns one turn into 2–6 actual
 * API calls in a tight burst, spiking instantaneous RPM past the cap →
 * HTTP 429 → the AI SDK exhausts its transport-retry budget →
 * `AI_RetryError: Too Many Requests` → the smoke test fails.
 *
 * FIX: pace at the single chokepoint every LLM call passes through —
 * `generateChat`. `generateChat` `await`s `awaitLiveCallSlot()` immediately
 * before dispatching `generateText`, so EVERY actual API call (including
 * `executeTurn`'s validation-retry calls) is throttled, not just turns.
 *
 * Spacing value: `LLM.liveCallMinSpacingMs` (2500ms) — safely above the
 * 30 RPM floor (2000ms) with margin for clock skew and response-time
 * variance. Now that it applies per-CALL rather than per-turn, this
 * genuinely eliminates the retry bursts.
 *
 * The gate is a complete no-op unless `CEREBRAS_LIVE === "1"`: production,
 * CI, `just check`, and all unit/integration tests incur zero added latency
 * and zero behaviour change.
 */

// Module-level mutable state: the dispatch timestamp of the previous LLM
// call. A rate limiter is inherently stateful — this is the one honest
// `let` exception to `eslint-plugin-functional`'s `no-let`. Initialised to
// 0 so the first call (in any process) is never delayed.
// eslint-disable-next-line functional/no-let
let lastDispatchAt = 0;

/**
 * Block until enough time has elapsed since the previous LLM call's dispatch
 * to respect the Cerebras free-tier rate limit, then record this call's
 * dispatch time.
 *
 * No-op (returns immediately) unless `process.env.CEREBRAS_LIVE === "1"`.
 * The env var is read at call time, not module-load time, so test harnesses
 * that set it after import still take effect.
 *
 * No mutex/locking: live tests run with `fileParallelism: false` and `await`
 * turns sequentially, and `executeTurn`'s retries are sequential — so a
 * plain timestamp compare is sufficient and there is no interleaving to
 * guard against.
 *
 * @returns A promise that resolves once this call is cleared to dispatch.
 */
export async function awaitLiveCallSlot(): Promise<void> {
  // Env gate: outside live smoke this function does nothing at all.
  if (process.env.CEREBRAS_LIVE !== "1") return;

  // How long until this call's dispatch would be >= minSpacing after the
  // previous one. Negative/zero when enough time has already elapsed.
  const elapsed = Date.now() - lastDispatchAt;
  const waitMs = LLM.liveCallMinSpacingMs - elapsed;
  if (waitMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  // Record this call's dispatch time AFTER any wait, so it reflects the
  // moment the call is actually cleared to fire.
  lastDispatchAt = Date.now();
}
