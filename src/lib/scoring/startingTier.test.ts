import { describe, it, expect } from "vitest";
import type { QualityScore } from "@/lib/types/spaced-repetition";
import { determineStartingTier, type BaselineTierResult } from "./startingTier";

/** One graded baseline answer at `tier`. */
const result = (tier: number, qualityScore: QualityScore): BaselineTierResult => ({
  tier,
  qualityScore,
});

/** `count` answers at `tier`, all with the same score. */
const results = (tier: number, qualityScore: QualityScore, count: number) =>
  Array.from({ length: count }, () => result(tier, qualityScore));

// Scores at the edges of the bands. 4 is the lowest correct score; 3 is the
// highest partial one. A correct MC click scores 4 and a wrong one scores 1.
const RIGHT: QualityScore = 4;
const PARTIAL: QualityScore = 3;
const WRONG: QualityScore = 1;

describe("determineStartingTier", () => {
  it("starts at the lowest in-scope tier when every answer is wrong", () => {
    const answers = [...results(1, WRONG, 3), ...results(2, WRONG, 3), ...results(3, WRONG, 3)];
    expect(determineStartingTier({ results: answers, scopeTiers: [1, 2, 3] })).toBe(1);
  });

  it("starts at the highest in-scope tier when every answer is right", () => {
    const answers = [...results(1, RIGHT, 3), ...results(2, RIGHT, 3), ...results(3, RIGHT, 3)];
    expect(determineStartingTier({ results: answers, scopeTiers: [1, 2, 3] })).toBe(3);
  });

  it("starts at the first tier not mastered, above a mastered one", () => {
    const answers = [...results(1, RIGHT, 3), ...results(2, WRONG, 3), ...results(3, WRONG, 3)];
    expect(determineStartingTier({ results: answers, scopeTiers: [1, 2, 3] })).toBe(2);
  });

  // A strong higher tier does not excuse a weak lower one: teaching starts
  // at the gap.
  it("starts at a weak lower tier even when a higher tier is strong", () => {
    const answers = [...results(1, WRONG, 4), ...results(2, RIGHT, 4)];
    expect(determineStartingTier({ results: answers, scopeTiers: [1, 2] })).toBe(1);
  });

  it("returns the only tier of a one-tier scope, weak or strong", () => {
    expect(determineStartingTier({ results: results(2, WRONG, 7), scopeTiers: [2] })).toBe(2);
    expect(determineStartingTier({ results: results(2, RIGHT, 7), scopeTiers: [2] })).toBe(2);
  });

  // Issue #198: a partial answer (quality 3) earns XP but is not correct.
  // Placement counts correct answers only.
  it("does not count partial answers as correct", () => {
    const answers = [...results(1, PARTIAL, 3), ...results(2, RIGHT, 3)];
    expect(determineStartingTier({ results: answers, scopeTiers: [1, 2] })).toBe(1);
  });

  // These two cases pin the comparison at the default ratio of 0.8. The first
  // fails if `>=` becomes `>`; the second fails if the threshold is ignored.
  it("counts a tier as mastered when its correct ratio equals the threshold", () => {
    const tier1 = [...results(1, RIGHT, 4), result(1, WRONG)]; // 4 of 5 = 0.8
    const answers = [...tier1, ...results(2, WRONG, 3)];
    expect(determineStartingTier({ results: answers, scopeTiers: [1, 2] })).toBe(2);
  });

  it("does not count a tier as mastered just below the threshold", () => {
    const tier1 = [...results(1, RIGHT, 3), result(1, WRONG)]; // 3 of 4 = 0.75
    const answers = [...tier1, ...results(2, RIGHT, 4)];
    expect(determineStartingTier({ results: answers, scopeTiers: [1, 2] })).toBe(1);
  });

  // No evidence, no skip: a tier the baseline never asked about is not
  // mastered.
  it("treats an in-scope tier with no answers as not mastered", () => {
    const answers = [...results(2, RIGHT, 4), ...results(3, RIGHT, 4)];
    expect(determineStartingTier({ results: answers, scopeTiers: [1, 2, 3] })).toBe(1);
  });

  it("ignores answers on tiers outside the scope", () => {
    const answers = [...results(1, WRONG, 3), ...results(2, RIGHT, 3), ...results(3, WRONG, 3)];
    expect(determineStartingTier({ results: answers, scopeTiers: [2, 3] })).toBe(3);
  });

  it("walks the scope from lowest to highest whatever its order", () => {
    const answers = [...results(1, RIGHT, 3), ...results(2, WRONG, 3), ...results(3, RIGHT, 3)];
    expect(determineStartingTier({ results: answers, scopeTiers: [3, 1, 2] })).toBe(2);
    const allRight = [...results(1, RIGHT, 3), ...results(2, RIGHT, 3)];
    expect(determineStartingTier({ results: allRight, scopeTiers: [2, 1] })).toBe(2);
  });

  it("throws on an empty scope", () => {
    expect(() => determineStartingTier({ results: [], scopeTiers: [] })).toThrow(/scope/);
  });
});
