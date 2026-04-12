import { describe, it, expect } from "vitest";
import { calculateXP } from "./xp";

describe("calculateXP", () => {
  describe("standard calculations", () => {
    it("tier 3 × quality 5 → 45 XP (1.5x multiplier)", () => {
      expect(calculateXP(3, 5)).toBe(45);
    });
    it("tier 2 × quality 2 → 5 XP (0.25x multiplier)", () => {
      expect(calculateXP(2, 2)).toBe(5);
    });
    it("tier 1 × quality 4 → 10 XP (1.0x multiplier)", () => {
      expect(calculateXP(1, 4)).toBe(10);
    });
    it("tier 5 × quality 3 → 38 XP (rounds 37.5 up)", () => {
      expect(calculateXP(5, 3)).toBe(38);
    });
    it("tier 8 × quality 5 → 120 XP", () => {
      expect(calculateXP(8, 5)).toBe(120);
    });
  });

  describe("zero-XP quality scores", () => {
    it("quality 0 → 0 XP regardless of tier", () => {
      expect(calculateXP(1, 0)).toBe(0);
      expect(calculateXP(5, 0)).toBe(0);
      expect(calculateXP(8, 0)).toBe(0);
    });
    it("quality 1 → 0 XP regardless of tier", () => {
      expect(calculateXP(1, 1)).toBe(0);
      expect(calculateXP(5, 1)).toBe(0);
    });
  });

  describe("input validation", () => {
    it("throws on invalid quality score", () => {
      expect(() => calculateXP(1, 6)).toThrow();
      expect(() => calculateXP(1, -1)).toThrow();
      expect(() => calculateXP(1, 2.5)).toThrow();
    });
    it("throws on tier < 1", () => {
      expect(() => calculateXP(0, 5)).toThrow();
      expect(() => calculateXP(-1, 5)).toThrow();
    });
    it("throws on non-integer tier", () => {
      expect(() => calculateXP(1.5, 5)).toThrow();
    });
  });
});
