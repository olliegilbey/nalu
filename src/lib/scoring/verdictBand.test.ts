import { describe, it, expect } from "vitest";
import { verdictForQualityScore } from "./verdictBand";

// Issue #198: one band table maps a score to its verdict. Every score 0-5
// is pinned, so a shifted band edge fails here.
describe("verdictForQualityScore", () => {
  it.each([
    [0, "incorrect"],
    [1, "incorrect"],
    [2, "partial"],
    [3, "partial"],
    [4, "correct"],
    [5, "correct"],
  ] as const)("maps qualityScore %i to %s", (qualityScore, verdict) => {
    expect(verdictForQualityScore(qualityScore)).toBe(verdict);
  });
});
