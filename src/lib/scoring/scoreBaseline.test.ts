import { describe, it, expect } from "vitest";
import { scoreBaseline, type StoredGrading } from "./scoreBaseline";
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

const mcWrongGrading = (id: string, conceptName: string, conceptTier: number): StoredGrading => ({
  questionId: id,
  conceptName,
  conceptTier,
  verdict: "incorrect",
  qualityScore: BASELINE.mcIncorrectQuality,
  rationale: "Selected B; correct option was A.",
});

describe("scoreBaseline", () => {
  // Canonical order = baseline.questions order. The LLM may return gradings
  // in any order; mechanical gradings arrive separately. The merge must
  // produce a single ordered list keyed by the baseline question ids.
  it("merges LLM and mechanical gradings in canonical question order", () => {
    const merged = scoreBaseline({
      parsed: { gradings: [llmGrading("b2", "borrows", 3)] },
      mechanicalGradings: [mcGrading("b1", "ownership", 2)],
      baselineQuestions: [
        { id: "b1", tier: 2 },
        { id: "b2", tier: 3 },
      ],
      scopeTiers: [1, 2, 3],
    });
    expect(merged.gradings.map((g) => g.questionId)).toEqual(["b1", "b2"]);
  });

  // Issue #94: deterministic code places the learner. Tier 1 is right and
  // tier 2 is wrong, so the learner starts at tier 2.
  it("computes the starting tier from the merged gradings", () => {
    const merged = scoreBaseline({
      parsed: { gradings: [llmGrading("b1", "ownership", 1)] },
      mechanicalGradings: [mcWrongGrading("b2", "borrows", 2)],
      baselineQuestions: [
        { id: "b1", tier: 1 },
        { id: "b2", tier: 2 },
      ],
      scopeTiers: [1, 2],
    });
    expect(merged.startingTier).toBe(2);
  });

  // The model emits a free-text grading's `conceptTier` after it reads the
  // answer. Placement files each answer under its question's tier, which
  // was fixed before the learner answered. Here the model relabels b1 as
  // tier 2. By conceptTier the learner would start at tier 1; by question
  // tier they mastered tier 1 and start at tier 2.
  it("places by each question's tier, not the model's conceptTier", () => {
    const merged = scoreBaseline({
      parsed: { gradings: [llmGrading("b1", "ownership", 2)] },
      mechanicalGradings: [mcWrongGrading("b2", "borrows", 2)],
      baselineQuestions: [
        { id: "b1", tier: 1 },
        { id: "b2", tier: 2 },
      ],
      scopeTiers: [1, 2],
    });
    expect(merged.startingTier).toBe(2);
  });

  // XP uses the starting tier (the learner's placement), NOT each grading's
  // own `conceptTier`. Both tiers are mastered here, so placement is the top
  // of scope, tier 3.
  it("computes totalXp as the sum of calculateXP(startingTier, qualityScore)", () => {
    const merged = scoreBaseline({
      parsed: { gradings: [llmGrading("b2", "borrows", 3)] },
      mechanicalGradings: [mcGrading("b1", "ownership", 2)],
      baselineQuestions: [
        { id: "b1", tier: 2 },
        { id: "b2", tier: 3 },
      ],
      scopeTiers: [2, 3],
    });
    expect(merged.startingTier).toBe(3);
    const expected = calculateXP(3, BASELINE.mcCorrectQuality) + calculateXP(3, 5);
    expect(merged.totalXp).toBe(expected);
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
    const merged = scoreBaseline({
      parsed: { gradings: [llmConflict] },
      mechanicalGradings: [mechanical],
      baselineQuestions: [{ id: "b1", tier: 2 }],
      scopeTiers: [2],
    });
    expect(merged.gradings).toEqual([mechanical]);
    // XP follows the mechanical quality, not the LLM's qualityScore=0.
    expect(merged.totalXp).toBe(calculateXP(2, BASELINE.mcCorrectQuality));
    // The LLM emitted a grading for this MC qid, but it's still a mechanical
    // question — it must not leak into the free-text subtotal.
    expect(merged.freeTextXp).toBe(0);
  });

  // `freeTextXp` is the subtotal the client needs after a baseline close.
  // MC XP is counted instantly client-side (Composer `calculateMcXp`), so the
  // server return must carry the free-text XP ONLY — returning the full total
  // would double-count MC. A question is free-text iff it has no mechanical
  // (MC-click) grading; that includes a freetext-escape answer on an MC
  // question (LLM-graded, not mechanical).
  it("computes freeTextXp over LLM-graded questions only, excluding mechanical MC", () => {
    const merged = scoreBaseline({
      parsed: { gradings: [llmGrading("b2", "borrows", 3)] },
      mechanicalGradings: [mcGrading("b1", "ownership", 2)],
      baselineQuestions: [
        { id: "b1", tier: 2 },
        { id: "b2", tier: 3 },
      ],
      scopeTiers: [2, 3],
    });
    // Only b2 (free-text) contributes; b1 (mechanical MC) is excluded.
    expect(merged.freeTextXp).toBe(calculateXP(merged.startingTier, 5));
  });

  it("returns freeTextXp 0 when every baseline question is mechanical MC", () => {
    const merged = scoreBaseline({
      parsed: { gradings: [] },
      mechanicalGradings: [mcGrading("b1", "ownership", 2), mcGrading("b2", "borrows", 3)],
      baselineQuestions: [
        { id: "b1", tier: 2 },
        { id: "b2", tier: 3 },
      ],
      scopeTiers: [1, 2, 3],
    });
    expect(merged.freeTextXp).toBe(0);
  });

  it("throws on conceptTier outside scopeTiers", () => {
    expect(() =>
      scoreBaseline({
        parsed: { gradings: [llmGrading("b1", "x", 99)] },
        mechanicalGradings: [],
        baselineQuestions: [{ id: "b1", tier: 1 }],
        scopeTiers: [1, 2, 3],
      }),
    ).toThrow(/conceptTier/);
  });

  it("throws when a baseline question has no grading", () => {
    expect(() =>
      scoreBaseline({
        parsed: { gradings: [] },
        mechanicalGradings: [],
        baselineQuestions: [{ id: "b1", tier: 1 }],
        scopeTiers: [1],
      }),
    ).toThrow(/no grading for questionId b1/);
  });
});
