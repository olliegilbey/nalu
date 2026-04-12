import { describe, it, expect } from "vitest";
import { calculateSM2, SM2_DEFAULTS } from "./sm2";
import { SM2 } from "@/lib/config/tuning";

// Fixed reference time for deterministic tests. Any Date works — SM-2 only
// uses `now` to compute nextReviewAt = now + interval days.
const NOW = new Date("2026-01-01T00:00:00Z");
const DAY_MS = 86_400_000;

describe("calculateSM2", () => {
  describe("successful recall (quality >= 3)", () => {
    it("new card with q=5: rep→1, interval→1 day, EF→2.6", () => {
      const result = calculateSM2(SM2_DEFAULTS, 5, NOW);
      expect(result.repetitionCount).toBe(1);
      expect(result.interval).toBe(1);
      // EF' = 2.5 + (0.1 - 0*(0.08+0)) = 2.6
      expect(result.easinessFactor).toBeCloseTo(2.6, 5);
      expect(result.nextReviewAt.getTime()).toBe(NOW.getTime() + 1 * DAY_MS);
    });

    it("second review with q=4: rep→2, interval→6 days, EF unchanged", () => {
      const state = { easinessFactor: 2.5, interval: 1, repetitionCount: 1 };
      const result = calculateSM2(state, 4, NOW);
      expect(result.repetitionCount).toBe(2);
      expect(result.interval).toBe(6);
      // EF' = 2.5 + (0.1 - 1*(0.08+0.02)) = 2.5
      expect(result.easinessFactor).toBeCloseTo(2.5, 5);
      expect(result.nextReviewAt.getTime()).toBe(NOW.getTime() + 6 * DAY_MS);
    });

    it("third review (rep 2+) with q=3: interval = round(prev * EF), EF decreases", () => {
      const state = { easinessFactor: 2.5, interval: 6, repetitionCount: 2 };
      const result = calculateSM2(state, 3, NOW);
      expect(result.repetitionCount).toBe(3);
      // interval = round(6 * 2.5) = 15 — computed with OLD EF before adjustment
      expect(result.interval).toBe(15);
      // EF' = 2.5 + (0.1 - 2*(0.08+0.04)) = 2.5 - 0.14 = 2.36
      expect(result.easinessFactor).toBeCloseTo(2.36, 5);
    });

    it("q=3 is the success path (rep increments, interval grows)", () => {
      const state = { easinessFactor: 2.5, interval: 6, repetitionCount: 2 };
      const result = calculateSM2(state, 3, NOW);
      expect(result.repetitionCount).toBe(3);
      expect(result.interval).toBeGreaterThan(1);
    });
  });

  describe("failure (quality < 3)", () => {
    it("q=2 resets: rep→0, interval→1 day", () => {
      const state = { easinessFactor: 2.36, interval: 15, repetitionCount: 3 };
      const result = calculateSM2(state, 2, NOW);
      expect(result.repetitionCount).toBe(0);
      expect(result.interval).toBe(1);
      expect(result.nextReviewAt.getTime()).toBe(NOW.getTime() + 1 * DAY_MS);
    });

    it("q=0 still adjusts EF but floors at 1.3", () => {
      const state = { easinessFactor: 1.4, interval: 10, repetitionCount: 4 };
      const result = calculateSM2(state, 0, NOW);
      // EF' = 1.4 + (0.1 - 5*(0.08+0.1)) = 1.4 - 0.8 = 0.6 → floored to 1.3
      expect(result.easinessFactor).toBe(SM2.easinessFactorFloor);
      expect(result.repetitionCount).toBe(0);
      expect(result.interval).toBe(1);
    });

    it("EF already at floor stays at floor on q=0", () => {
      const state = { easinessFactor: 1.3, interval: 5, repetitionCount: 2 };
      const result = calculateSM2(state, 0, NOW);
      expect(result.easinessFactor).toBe(SM2.easinessFactorFloor);
    });
  });

  describe("input validation", () => {
    it("throws on quality score > 5", () => {
      expect(() => calculateSM2(SM2_DEFAULTS, 6, NOW)).toThrow();
    });
    it("throws on negative quality score", () => {
      expect(() => calculateSM2(SM2_DEFAULTS, -1, NOW)).toThrow();
    });
    it("throws on non-integer quality score", () => {
      expect(() => calculateSM2(SM2_DEFAULTS, 3.5, NOW)).toThrow();
    });
  });

  describe("purity", () => {
    it("does not mutate input state", () => {
      const state = { easinessFactor: 2.5, interval: 6, repetitionCount: 2 };
      const snapshot = { ...state };
      calculateSM2(state, 4, NOW);
      expect(state).toEqual(snapshot);
    });

    it("uses provided `now` for nextReviewAt", () => {
      const customNow = new Date("2030-06-15T12:00:00Z");
      const result = calculateSM2(SM2_DEFAULTS, 5, customNow);
      expect(result.nextReviewAt.getTime()).toBe(customNow.getTime() + 1 * DAY_MS);
    });
  });
});
