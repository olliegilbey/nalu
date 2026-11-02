// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { playCorrect } from "@/lib/sound";
import { useXpBadge } from "./useXpBadge";

// WebAudio is not under test: spy on the one sound the badge may play.
vi.mock("@/lib/sound", () => ({ playCorrect: vi.fn() }));

beforeEach(() => {
  vi.mocked(playCorrect).mockClear();
});

/** Render the badge hook with a server total the test can change. */
function renderBadge(initialTotal: number | undefined) {
  return renderHook(({ totalXp }) => useXpBadge(totalXp), {
    initialProps: { totalXp: initialTotal },
  });
}

describe("useXpBadge", () => {
  it("shows the server total on mount with no pulse and no sound", () => {
    const { result } = renderBadge(120);
    expect(result.current.xp).toBe(120);
    expect(result.current.pulseKey).toBe(0);
    expect(playCorrect).not.toHaveBeenCalled();
  });

  it("shows 0 while the total loads, then the first total without a pulse", () => {
    const { result, rerender } = renderBadge(undefined);
    expect(result.current.xp).toBe(0);
    rerender({ totalXp: 70 });
    expect(result.current.xp).toBe(70);
    expect(result.current.pulseKey).toBe(0);
  });

  it("pulses with the gain on a rise, with no sound", () => {
    const { result, rerender } = renderBadge(40);
    rerender({ totalXp: 65 });
    expect(result.current.xp).toBe(65);
    expect(result.current.pulseKey).toBe(1);
    expect(result.current.gainAmount).toBe(25);
    expect(playCorrect).not.toHaveBeenCalled();
  });

  it("plays the correct sound once on the rise after a typed answer", () => {
    const { result, rerender } = renderBadge(40);
    act(() => result.current.soundOnNextRise(true));
    rerender({ totalXp: 65 });
    expect(playCorrect).toHaveBeenCalledTimes(1);
    // The sound belongs to that one answer; the next rise is silent.
    rerender({ totalXp: 80 });
    expect(playCorrect).toHaveBeenCalledTimes(1);
  });

  it("plays nothing on the rise after an all-MC submit", () => {
    // Each correct pick already played its sound at confirm.
    const { result, rerender } = renderBadge(40);
    act(() => result.current.soundOnNextRise(false));
    rerender({ totalXp: 65 });
    expect(result.current.pulseKey).toBe(1);
    expect(playCorrect).not.toHaveBeenCalled();
  });

  it("does nothing on a repeat of the same total", () => {
    const { result, rerender } = renderBadge(40);
    rerender({ totalXp: 65 });
    act(() => result.current.soundOnNextRise(true));
    // The refetch after a Turn repeats the turn result's total.
    rerender({ totalXp: 65 });
    expect(result.current.pulseKey).toBe(1);
    expect(playCorrect).not.toHaveBeenCalled();
  });

  it("keeps the last total while a refetch reloads it", () => {
    const { result, rerender } = renderBadge(65);
    rerender({ totalXp: undefined });
    expect(result.current.xp).toBe(65);
    rerender({ totalXp: 65 });
    expect(result.current.pulseKey).toBe(0);
  });
});
