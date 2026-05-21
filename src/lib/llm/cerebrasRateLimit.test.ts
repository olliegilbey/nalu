import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM } from "@/lib/config/tuning";
import {
  __resetCerebrasRateLimitStateForTests,
  awaitCerebrasCallSlot,
  recordCerebrasRateLimitHeaders,
} from "./cerebrasRateLimit";

/**
 * Unit tests for the header-aware Cerebras rate limiter.
 *
 * The acquire/record pair is the testable seam — it never touches the real
 * Cerebras API. We drive `setTimeout` with vitest fake timers and assert:
 * the no-op gate, request spacing (immediate / elapsed / partial), and the
 * token-budget backoff (low / healthy / no-headers).
 *
 * The limiter owns module-level state (dispatch clock + last-seen token
 * budget). Every test calls `__resetCerebrasRateLimitStateForTests()` in a
 * `beforeEach` so prior cases can never bleed into the next assertion.
 *
 * Gating depends on `VITEST` + `CEREBRAS_LIVE`. Vitest sets `VITEST` for
 * this run, so by default the limiter is INERT — we must set
 * `CEREBRAS_LIVE=1` to exercise the active paths, and restore it after.
 */
describe("cerebrasRateLimit", () => {
  // Snapshot CEREBRAS_LIVE so each test can set it freely and restore after.
  const originalCerebrasLive = process.env.CEREBRAS_LIVE;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetCerebrasRateLimitStateForTests();
  });

  afterEach(() => {
    // Restore env: delete if it was unset, otherwise put the value back.
    if (originalCerebrasLive === undefined) {
      delete process.env.CEREBRAS_LIVE;
    } else {
      process.env.CEREBRAS_LIVE = originalCerebrasLive;
    }
    vi.useRealTimers();
  });

  /**
   * Resolve a promise while letting fake timers fire. `awaitCerebrasCallSlot`
   * may schedule one or more `setTimeout`s; we flush all pending timers,
   * then await. Returns how many ms of fake time elapsed before resolution.
   */
  async function measure(call: Promise<void>): Promise<number> {
    const start = Date.now();
    // Run any setTimeout the call scheduled (no-op path schedules none).
    await vi.runAllTimersAsync();
    await call;
    return Date.now() - start;
  }

  describe("gating — inert in mocked test context", () => {
    it("no-ops with zero delay when CEREBRAS_LIVE is unset", async () => {
      // VITEST is set by the runner; without CEREBRAS_LIVE the gate is off.
      delete process.env.CEREBRAS_LIVE;

      // Two back-to-back calls — neither should incur any delay.
      const firstDelay = await measure(awaitCerebrasCallSlot());
      const secondDelay = await measure(awaitCerebrasCallSlot());

      expect(firstDelay).toBe(0);
      expect(secondDelay).toBe(0);
    });

    it('no-ops when CEREBRAS_LIVE is not exactly "1"', async () => {
      // Only the exact string "1" arms the gate — "true"/"0" must not.
      process.env.CEREBRAS_LIVE = "true";

      const delay = await measure(awaitCerebrasCallSlot());

      expect(delay).toBe(0);
    });
  });

  describe("request spacing — active under CEREBRAS_LIVE=1", () => {
    beforeEach(() => {
      process.env.CEREBRAS_LIVE = "1";
    });

    it("does not delay the first call (no prior dispatch)", async () => {
      const firstDelay = await measure(awaitCerebrasCallSlot());
      expect(firstDelay).toBe(0);
    });

    it("delays an immediate second call by the full min-spacing", async () => {
      // First call fires immediately and records its dispatch time.
      await measure(awaitCerebrasCallSlot());

      // Second call made immediately after — must wait the full spacing.
      const secondDelay = await measure(awaitCerebrasCallSlot());
      expect(secondDelay).toBe(LLM.minRequestSpacingMs);
    });

    it("does not delay when more than min-spacing has already elapsed", async () => {
      await measure(awaitCerebrasCallSlot());

      // Advance the fake clock well past the spacing window.
      await vi.advanceTimersByTimeAsync(LLM.minRequestSpacingMs + 1_000);

      // The next call's slot is already clear — it must not wait.
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(0);
    });

    it("waits only the remaining spacing when the window is partly elapsed", async () => {
      await measure(awaitCerebrasCallSlot());

      // Advance partway through the spacing window — less than min-spacing.
      const partialElapsed = 4_000;
      await vi.advanceTimersByTimeAsync(partialElapsed);

      // The next call must wait only the REMAINDER, exercising the
      // `minSpacing - elapsed` arithmetic directly (not just its boundaries).
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(LLM.minRequestSpacingMs - partialElapsed);
    });
  });

  describe("token-budget backoff — active under CEREBRAS_LIVE=1", () => {
    beforeEach(() => {
      process.env.CEREBRAS_LIVE = "1";
    });

    it("does not wait for the token bucket when no headers have been seen", async () => {
      // First call: state is fresh, no headers recorded → spacing only,
      // which is 0 for the first call.
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(0);
    });

    it("does not wait when remaining token budget is healthy", async () => {
      // First call clears, then we record HEALTHY headers.
      await measure(awaitCerebrasCallSlot());
      recordCerebrasRateLimitHeaders({
        "x-ratelimit-remaining-tokens-minute": String(LLM.lowTokenBudgetThreshold + 5_000),
        "x-ratelimit-reset-tokens-minute": "30",
      });

      // Advance past the spacing window so request spacing contributes 0.
      await vi.advanceTimersByTimeAsync(LLM.minRequestSpacingMs + 1_000);

      // Healthy budget → no token wait, and spacing already elapsed → 0.
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(0);
    });

    it("waits until the bucket reset when remaining token budget is low", async () => {
      // First call clears, then we record LOW headers with a 25s reset.
      await measure(awaitCerebrasCallSlot());
      const resetSeconds = 25;
      recordCerebrasRateLimitHeaders({
        "x-ratelimit-remaining-tokens-minute": String(LLM.lowTokenBudgetThreshold - 1),
        "x-ratelimit-reset-tokens-minute": String(resetSeconds),
      });

      // Advance past the request-spacing window so the only remaining wait
      // is the token-bucket backoff — isolates the token gate cleanly.
      await vi.advanceTimersByTimeAsync(LLM.minRequestSpacingMs + 1_000);
      const elapsedSinceRecord = LLM.minRequestSpacingMs + 1_000;

      // The acquire must wait the remainder of the 25s reset window.
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(resetSeconds * 1_000 - elapsedSinceRecord);
    });

    it("does not wait when the recorded bucket reset is already in the past", async () => {
      await measure(awaitCerebrasCallSlot());
      recordCerebrasRateLimitHeaders({
        "x-ratelimit-remaining-tokens-minute": String(LLM.lowTokenBudgetThreshold - 1),
        "x-ratelimit-reset-tokens-minute": "5",
      });

      // Advance well past both the reset window and the spacing window.
      await vi.advanceTimersByTimeAsync(LLM.minRequestSpacingMs + 10_000);

      // Low budget but the reset deadline already passed → no wait.
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(0);
    });

    it("ignores malformed headers and applies request spacing only", async () => {
      await measure(awaitCerebrasCallSlot());
      // Non-numeric values → record leaves token state null.
      recordCerebrasRateLimitHeaders({
        "x-ratelimit-remaining-tokens-minute": "not-a-number",
        "x-ratelimit-reset-tokens-minute": "also-bad",
      });

      // Immediate next call: no token gate (state stayed null), so only the
      // request-spacing wait applies.
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(LLM.minRequestSpacingMs);
    });

    it("ignores undefined headers (provider exposed none)", async () => {
      await measure(awaitCerebrasCallSlot());
      // AI SDK reports `undefined` when the provider used no HTTP transport.
      recordCerebrasRateLimitHeaders(undefined);

      const delay = await measure(awaitCerebrasCallSlot());
      // No token gate; request spacing only.
      expect(delay).toBe(LLM.minRequestSpacingMs);
    });
  });
});
