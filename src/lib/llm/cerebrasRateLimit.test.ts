import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM } from "@/lib/config/tuning";
import {
  __resetCerebrasRateLimitStateForTests,
  awaitCerebrasCallSlot,
  recordCerebrasRateLimitHeaders,
} from "./cerebrasRateLimit";
import { userIdStore } from "./userIdStore";

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
  beforeEach(() => {
    vi.useFakeTimers();
    __resetCerebrasRateLimitStateForTests();
  });

  afterEach(() => {
    // `vi.unstubAllEnvs` restores any CEREBRAS_LIVE stub set in a test —
    // the idiomatic Vitest approach, no mutable snapshot to track.
    vi.unstubAllEnvs();
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
      vi.stubEnv("CEREBRAS_LIVE", undefined);

      // Two back-to-back calls — neither should incur any delay.
      const firstDelay = await measure(awaitCerebrasCallSlot());
      const secondDelay = await measure(awaitCerebrasCallSlot());

      expect(firstDelay).toBe(0);
      expect(secondDelay).toBe(0);
    });

    it('no-ops when CEREBRAS_LIVE is not exactly "1"', async () => {
      // Only the exact string "1" arms the gate — "true"/"0" must not.
      vi.stubEnv("CEREBRAS_LIVE", "true");

      const delay = await measure(awaitCerebrasCallSlot());

      expect(delay).toBe(0);
    });
  });

  describe("request spacing — active under CEREBRAS_LIVE=1", () => {
    beforeEach(() => {
      vi.stubEnv("CEREBRAS_LIVE", "1");
    });

    it("does not delay the first call (no prior dispatch)", async () => {
      const firstDelay = await measure(awaitCerebrasCallSlot());
      expect(firstDelay).toBe(0);
    });

    it("delays an immediate second call by the full fast-lane spacing", async () => {
      // First call fires immediately and records its dispatch time.
      await measure(awaitCerebrasCallSlot());

      // Second call made immediately after — must wait the full spacing.
      const secondDelay = await measure(awaitCerebrasCallSlot());
      expect(secondDelay).toBe(LLM.fastLaneSpacingMs);
    });

    it("does not delay when more than fast-lane spacing has already elapsed", async () => {
      await measure(awaitCerebrasCallSlot());

      // Advance the fake clock well past the spacing window.
      await vi.advanceTimersByTimeAsync(LLM.fastLaneSpacingMs + 1_000);

      // The next call's slot is already clear — it must not wait.
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(0);
    });

    it("waits only the remaining spacing when the window is partly elapsed", async () => {
      await measure(awaitCerebrasCallSlot());

      // Advance partway through the spacing window — less than the fast-lane spacing.
      const partialElapsed = 50;
      await vi.advanceTimersByTimeAsync(partialElapsed);

      // The next call must wait only the REMAINDER, exercising the
      // `spacing - elapsed` arithmetic directly (not just its boundaries).
      const delay = await measure(awaitCerebrasCallSlot());
      expect(delay).toBe(LLM.fastLaneSpacingMs - partialElapsed);
    });
  });

  describe("token-budget backoff — active under CEREBRAS_LIVE=1", () => {
    beforeEach(() => {
      vi.stubEnv("CEREBRAS_LIVE", "1");
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
      await vi.advanceTimersByTimeAsync(LLM.fastLaneSpacingMs + 1_000);

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
      await vi.advanceTimersByTimeAsync(LLM.fastLaneSpacingMs + 1_000);
      const elapsedSinceRecord = LLM.fastLaneSpacingMs + 1_000;

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
      await vi.advanceTimersByTimeAsync(LLM.fastLaneSpacingMs + 10_000);

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
      expect(delay).toBe(LLM.fastLaneSpacingMs);
    });

    it("ignores undefined headers (provider exposed none)", async () => {
      await measure(awaitCerebrasCallSlot());
      // AI SDK reports `undefined` when the provider used no HTTP transport.
      recordCerebrasRateLimitHeaders(undefined);

      const delay = await measure(awaitCerebrasCallSlot());
      // No token gate; request spacing only.
      expect(delay).toBe(LLM.fastLaneSpacingMs);
    });
  });

  // `_` is the conventional unused loop binding for fixed-count for-of loops
  // (codebase forbids `for (let i ...)`); disable scoped to this block.
  /* eslint-disable @typescript-eslint/no-unused-vars -- _ is intentional unused binding */
  describe("per-user fast/slow lane — active under CEREBRAS_LIVE=1", () => {
    beforeEach(() => {
      vi.stubEnv("CEREBRAS_LIVE", "1");
    });

    /**
     * Wrap a call in the userIdStore so the limiter sees the userId.
     * Returns how many ms of fake time elapsed before resolution.
     */
    async function measureForUser(userId: string): Promise<number> {
      return userIdStore.run(userId, async () => measure(awaitCerebrasCallSlot()));
    }

    it("applies fast-lane spacing for a user's first call", async () => {
      // First call for any user: count is 0, fast-lane path; spacing is
      // 0 because there's no prior dispatch.
      const delay = await measureForUser("user-a");
      expect(delay).toBe(0);
    });

    it("applies fast-lane spacing through the threshold-th call", async () => {
      // Run fastLaneCallsPerUser calls back-to-back. The first call has no
      // prior dispatch (delay 0). Every subsequent call must wait
      // fastLaneSpacingMs — never the slow-lane floor.
      const first = await measureForUser("user-a");
      expect(first).toBe(0);

      // Iterate (threshold - 1) more times. Codebase uses for...of only
      // (eslint-plugin-functional `no-let`); `Array.from({ length })` is
      // the idiomatic way to spin a fixed count without an index var.
      for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser - 1 })) {
        const delay = await measureForUser("user-a");
        expect(delay).toBe(LLM.fastLaneSpacingMs);
      }
    });

    it("flips to slow-lane spacing on the call after the threshold", async () => {
      // Exhaust the fast-lane window for user-a.
      for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser })) {
        await measureForUser("user-a");
      }

      // The (threshold + 1)-th call must wait the slow-lane floor.
      const delay = await measureForUser("user-a");
      expect(delay).toBe(LLM.slowLaneSpacingMs);
    });

    it("counts users independently", async () => {
      // user-a burns through their entire fast-lane window.
      for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser })) {
        await measureForUser("user-a");
      }

      // user-b's first call must still be on the fast lane — note that
      // spacing is the FAST value, not zero, because user-a's last call
      // set the global dispatch clock. The spacing gate is global; the
      // lane choice is per-user.
      const delay = await measureForUser("user-b");
      expect(delay).toBe(LLM.fastLaneSpacingMs);
    });

    it("uses fast lane and does not mutate the counter when no userId is in scope", async () => {
      // No userIdStore.run wrapper — simulates smoke / CLI / background.
      // First call: no prior dispatch, delay 0.
      const first = await measure(awaitCerebrasCallSlot());
      expect(first).toBe(0);

      // Second call without userId: must use fast-lane spacing, not slow.
      const second = await measure(awaitCerebrasCallSlot());
      expect(second).toBe(LLM.fastLaneSpacingMs);

      // Even after threshold-many no-userId calls, the next call with a
      // userId still gets the fast lane (no-userId calls do not consume
      // any user's budget).
      for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser + 5 })) {
        await measure(awaitCerebrasCallSlot());
      }
      const userCall = await measureForUser("user-c");
      expect(userCall).toBe(LLM.fastLaneSpacingMs);
    });

    it("__resetCerebrasRateLimitStateForTests clears per-user counts", async () => {
      // Burn user-a's fast lane.
      for (const _ of Array.from({ length: LLM.fastLaneCallsPerUser })) {
        await measureForUser("user-a");
      }

      // Reset, then user-a's next call must be back on the fast lane.
      __resetCerebrasRateLimitStateForTests();
      // After reset, no prior dispatch → first call delay is 0.
      const delay = await measureForUser("user-a");
      expect(delay).toBe(0);
    });
  });
  /* eslint-enable @typescript-eslint/no-unused-vars */
});
