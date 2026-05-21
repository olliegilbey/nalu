import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM } from "@/lib/config/tuning";
import { awaitLiveCallSlot } from "./liveCallPacing";

/**
 * Unit tests for the live-smoke call-site rate limiter.
 *
 * The pacing function is the testable seam — it never touches the real
 * Cerebras API. We drive `setTimeout` with vitest fake timers and assert
 * the no-op gate, the spacing delay, and the "already-elapsed" fast path.
 *
 * `awaitLiveCallSlot` owns module-level state (the last-dispatch timestamp).
 * Tests therefore advance the fake clock far enough between cases that the
 * prior dispatch can never bleed into the next assertion.
 */
describe("awaitLiveCallSlot", () => {
  // Snapshot CEREBRAS_LIVE so each test can set it freely and restore after.
  const originalCerebrasLive = process.env.CEREBRAS_LIVE;

  beforeEach(() => {
    vi.useFakeTimers();
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
   * Resolve a promise while letting fake timers fire. `awaitLiveCallSlot`
   * may schedule a `setTimeout`; we flush all pending timers, then await.
   * Returns how many ms of fake time elapsed before the promise resolved.
   */
  async function measure(call: Promise<void>): Promise<number> {
    const start = Date.now();
    // Run any setTimeout the call scheduled (no-op path schedules none).
    await vi.runAllTimersAsync();
    await call;
    return Date.now() - start;
  }

  it("no-ops with zero delay when CEREBRAS_LIVE is unset", async () => {
    delete process.env.CEREBRAS_LIVE;

    // Two back-to-back calls — neither should incur any delay.
    const firstDelay = await measure(awaitLiveCallSlot());
    const secondDelay = await measure(awaitLiveCallSlot());

    expect(firstDelay).toBe(0);
    expect(secondDelay).toBe(0);
  });

  it('no-ops with zero delay when CEREBRAS_LIVE is not exactly "1"', async () => {
    // Only the exact string "1" arms the gate — "true"/"0" must not.
    process.env.CEREBRAS_LIVE = "true";

    const delay = await measure(awaitLiveCallSlot());

    expect(delay).toBe(0);
  });

  it('delays a second call by ~minSpacing when CEREBRAS_LIVE="1"', async () => {
    process.env.CEREBRAS_LIVE = "1";

    // First call: nothing has been dispatched yet, so it fires immediately
    // and records the dispatch time.
    const firstDelay = await measure(awaitLiveCallSlot());
    expect(firstDelay).toBe(0);

    // Second call made immediately after — must wait the full spacing.
    const secondDelay = await measure(awaitLiveCallSlot());
    expect(secondDelay).toBe(LLM.liveCallMinSpacingMs);
  });

  it("does NOT delay when more than minSpacing has already elapsed", async () => {
    process.env.CEREBRAS_LIVE = "1";

    // First call records its dispatch timestamp.
    await measure(awaitLiveCallSlot());

    // Advance the fake clock well past the spacing window.
    await vi.advanceTimersByTimeAsync(LLM.liveCallMinSpacingMs + 1_000);

    // The next call's slot is already clear — it must not wait.
    const delay = await measure(awaitLiveCallSlot());
    expect(delay).toBe(0);
  });

  it("waits only the remaining spacing when the window is partly elapsed", async () => {
    process.env.CEREBRAS_LIVE = "1";

    // First call records its dispatch timestamp.
    await measure(awaitLiveCallSlot());

    // Advance partway through the spacing window — less than minSpacing.
    const partialElapsed = 1_000;
    await vi.advanceTimersByTimeAsync(partialElapsed);

    // The next call must wait only the REMAINDER, exercising the
    // `minSpacing - elapsed` arithmetic directly (not just its boundaries).
    const delay = await measure(awaitLiveCallSlot());
    expect(delay).toBe(LLM.liveCallMinSpacingMs - partialElapsed);
  });
});
