import { describe, it, expect } from "vitest";
import { PROGRESSION } from "@/lib/config/tuning";
import type { QualityScore } from "@/lib/types/spaced-repetition";
import { determineStartingTier } from "./determineStartingTier";

/**
 * Build a grading with only the fields the placement rule cares about
 * (tier, qualityScore). Typed as inline object — `QuestionGrading` is gone
 * from the new gradeBaseline.ts shape.
 */
function g(
  _id: string,
  tier: number,
  qualityScore: QualityScore,
): { readonly qualityScore: QualityScore; readonly tier: number } {
  return {
    tier,
    qualityScore,
  };
}

describe("determineStartingTier", () => {
  it("mirrors the Rust sim: T1 solid, T2 weak, T3 unreached → starts at T2", () => {
    const gradings = [
      g("b1", 1, 4),
      g("b2", 1, 4),
      g("b3", 1, 5),
      g("b4", 2, 2),
      g("b5", 2, 1),
      g("b6", 2, 2),
      // Tier 3 has no gradings → unreached.
    ];
    expect(
      determineStartingTier({ gradings, estimatedStartingTier: 2, scopeTiers: [1, 2, 3] }),
    ).toBe(2);
  });

  it("every in-scope tier is comfortable → promotes to top of scope", () => {
    const gradings = [g("b1", 1, 4), g("b2", 2, 4), g("b3", 3, 5)];
    expect(
      determineStartingTier({ gradings, estimatedStartingTier: 2, scopeTiers: [1, 2, 3] }),
    ).toBe(3);
  });

  it("no tier has any gradings → falls back to the estimated tier", () => {
    // Defensive path. `BASELINE.minQuestions=7` plus the in-scope invariant
    // make this unreachable in the product, but the rule stays covered.
    expect(
      determineStartingTier({ gradings: [], estimatedStartingTier: 2, scopeTiers: [1, 2, 3] }),
    ).toBe(2);
  });

  it("single-tier scope with weak answers → returns that tier", () => {
    const gradings = [g("b1", 2, 1), g("b2", 2, 2)];
    expect(determineStartingTier({ gradings, estimatedStartingTier: 2, scopeTiers: [2] })).toBe(2);
  });

  it("single-tier scope with solid answers → returns that tier (top of scope rule)", () => {
    const gradings = [g("b1", 2, 4), g("b2", 2, 4)];
    expect(determineStartingTier({ gradings, estimatedStartingTier: 2, scopeTiers: [2] })).toBe(2);
  });

  it("avgQuality exactly at passingQualityScore counts as solid (boundary is inclusive)", () => {
    // Two q=3 answers average to 3. PROGRESSION.passingQualityScore=3.
    // avg < threshold is strict → tier counts as solid → skip to max scope.
    const gradings = [
      g("b1", 1, PROGRESSION.passingQualityScore as QualityScore),
      g("b2", 1, PROGRESSION.passingQualityScore as QualityScore),
      g("b3", 2, 4),
    ];
    expect(determineStartingTier({ gradings, estimatedStartingTier: 2, scopeTiers: [1, 2] })).toBe(
      2,
    );
  });

  it("first friction at T1 → starts at T1 (learner hasn't even mastered the base)", () => {
    const gradings = [g("b1", 1, 1), g("b2", 1, 2), g("b3", 2, 4)];
    expect(determineStartingTier({ gradings, estimatedStartingTier: 2, scopeTiers: [1, 2] })).toBe(
      1,
    );
  });

  it("unreached lower tier is skipped, not treated as friction", () => {
    // T1 unreached, T2 solid, T3 weak → first reached friction is T3.
    const gradings = [g("b1", 2, 4), g("b2", 2, 5), g("b3", 3, 1), g("b4", 3, 2)];
    expect(
      determineStartingTier({ gradings, estimatedStartingTier: 2, scopeTiers: [1, 2, 3] }),
    ).toBe(3);
  });

  it("tiers outside scope are ignored when aggregating", () => {
    // A tier-4 grading (shouldn't happen in practice, but defensively:
    // it must not contribute to scope placement).
    const gradings = [
      g("b1", 1, 4),
      g("b2", 2, 4),
      g("b3", 4, 0), // out-of-scope; must be ignored
    ];
    expect(determineStartingTier({ gradings, estimatedStartingTier: 2, scopeTiers: [1, 2] })).toBe(
      2,
    );
  });
});
