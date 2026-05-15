import { describe, it, expect } from "vitest";
import { mergeAndComputeXp, type StoredGrading } from "./baselineMerge";
import { BASELINE } from "@/lib/config/tuning";
import { calculateXP } from "@/lib/scoring/xp";

// Helpers build canonical LLM and mechanical grading entries. The shapes
// match `baselineGradingSchema` (questionId / conceptName / conceptTier /
// verdict / qualityScore / rationale) and respect the verdict→quality
// band superRefine. Explicit `StoredGrading` return type keeps the
// `qualityScore` literal types from widening to `number`.
const llmGrading = (id: string, conceptName: string, conceptTier: number): StoredGrading => ({
  questionId: id,
  conceptName,
  conceptTier,
  verdict: "correct",
  qualityScore: 5,
  rationale: "good",
});

const mcGrading = (id: string, conceptName: string, conceptTier: number): StoredGrading => ({
  questionId: id,
  conceptName,
  conceptTier,
  verdict: "correct",
  qualityScore: BASELINE.mcCorrectQuality,
  rationale: "Selected the correct option.",
});

describe("mergeAndComputeXp", () => {
  // Canonical order = baseline.questions order. The LLM may return gradings
  // in any order; mechanical gradings arrive separately. The merge must
  // produce a single ordered list keyed by baselineQuestionIds.
  it("merges LLM and mechanical gradings in canonical question order", () => {
    const merged = mergeAndComputeXp({
      parsed: {
        gradings: [llmGrading("b2", "borrows", 3)],
        startingTier: 2,
      },
      mechanicalGradings: [mcGrading("b1", "ownership", 2)],
      baselineQuestionIds: ["b1", "b2"],
      scopeTiers: [1, 2, 3],
    });
    expect(merged.gradings.map((g) => g.questionId)).toEqual(["b1", "b2"]);
  });

  // XP uses `startingTier` (the learner's placement) — NOT each grading's
  // own `conceptTier`. This matches the LLM-XP boundary: tier comes from
  // placement, quality from per-question grading.
  it("computes totalXp as the sum of calculateXP(startingTier, qualityScore)", () => {
    const merged = mergeAndComputeXp({
      parsed: {
        gradings: [llmGrading("b2", "borrows", 3)],
        startingTier: 2,
      },
      mechanicalGradings: [mcGrading("b1", "ownership", 2)],
      baselineQuestionIds: ["b1", "b2"],
      scopeTiers: [1, 2, 3],
    });
    const expected = calculateXP(2, BASELINE.mcCorrectQuality) + calculateXP(2, 5);
    expect(merged.totalXp).toBe(expected);
  });

  // Defence-in-depth: the LLM schema's superRefine should reject this
  // upstream, but a second assertion here makes a schema regression
  // fail loud at the orchestration boundary rather than corrupting
  // tier-advancement state.
  it("throws on startingTier outside scopeTiers (defence-in-depth)", () => {
    expect(() =>
      mergeAndComputeXp({
        parsed: { gradings: [], startingTier: 99 },
        mechanicalGradings: [],
        baselineQuestionIds: [],
        scopeTiers: [1, 2, 3],
      }),
    ).toThrow(/startingTier/);
  });

  // Mechanical MC grading is authoritative: the close-turn wire schema
  // requires the LLM to emit a grading for every question id (including MC),
  // but the LLM never actually grades MC answers — its entry for an MC qid
  // is discarded in favour of the deterministic mechanical grading.
  // Regression guard for the order-of-merge bug where the LLM's entry
  // silently overrode the mechanical one.
  it("keeps the mechanical grading when the LLM also emits one for the same questionId", () => {
    const mechanical = mcGrading("b1", "ownership", 2);
    const llmConflict: StoredGrading = {
      questionId: "b1",
      conceptName: "ownership",
      conceptTier: 2,
      verdict: "incorrect",
      qualityScore: 0,
      rationale: "model thought wrong",
    };
    const merged = mergeAndComputeXp({
      parsed: { gradings: [llmConflict], startingTier: 2 },
      mechanicalGradings: [mechanical],
      baselineQuestionIds: ["b1"],
      scopeTiers: [1, 2, 3],
    });
    expect(merged.gradings).toEqual([mechanical]);
    // XP follows the mechanical quality, not the LLM's qualityScore=0.
    expect(merged.totalXp).toBe(calculateXP(2, BASELINE.mcCorrectQuality));
  });

  it("throws on conceptTier outside scopeTiers", () => {
    expect(() =>
      mergeAndComputeXp({
        parsed: {
          gradings: [llmGrading("b1", "x", 99)],
          startingTier: 2,
        },
        mechanicalGradings: [],
        baselineQuestionIds: ["b1"],
        scopeTiers: [1, 2, 3],
      }),
    ).toThrow(/conceptTier/);
  });
});
