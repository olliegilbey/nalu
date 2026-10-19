import type { z } from "zod";
import type { baselineGradingSchema } from "@/lib/types/jsonb";
import { calculateXP } from "@/lib/scoring/xp";
import { determineStartingTier } from "@/lib/scoring/startingTier";

/** Persisted grading shape — matches `baselineGradingSchema` in jsonbBaseline. */
export type StoredGrading = z.infer<typeof baselineGradingSchema>;

/** Inputs to {@link scoreBaseline}. All readonly to keep callers honest. */
export interface ScoreBaselineParams {
  /** LLM-side parsed close-turn payload. `gradings` may be in any order. */
  readonly parsed: {
    readonly gradings: readonly StoredGrading[];
  };
  /** Mechanical MC gradings produced by `gradeMc` (deterministic, no LLM). */
  readonly mechanicalGradings: readonly StoredGrading[];
  /**
   * `baseline.questions` in canonical order: each id with the tier the
   * question was generated at. Placement reads these tiers.
   */
  readonly baselineQuestions: readonly { readonly id: string; readonly tier: number }[];
  /** Tiers that exist in the framework. Anything outside is a contract bug. */
  readonly scopeTiers: readonly number[];
}

/** Pure output: ordered gradings, the starting tier, and deterministic XP. */
export interface ScoreBaselineResult {
  readonly gradings: readonly StoredGrading[];
  /** Tier Wave 1 starts at, from `determineStartingTier`. Baseline XP is scored at it. */
  readonly startingTier: number;
  readonly totalXp: number;
  /**
   * XP subtotal for free-text (LLM-graded) baseline questions only — i.e.
   * `totalXp` minus the mechanical-MC contribution. The client needs this
   * separately: correct MC answers are scored instantly client-side
   * (`calculateMcXp`), so the post-close badge must add ONLY the free-text
   * portion or MC XP would be counted twice.
   */
  readonly freeTextXp: number;
}

/**
 * Score a graded baseline in three steps. Merge LLM and mechanical gradings
 * into one canonically-ordered list. Place the learner with
 * `determineStartingTier`. Compute total XP for the baseline at that tier.
 * Also returns a free-text-only XP subtotal the client uses to avoid
 * double-counting instantly-scored MC answers.
 *
 * Lives under `src/lib/scoring/` because it is a pure scoring/aggregation
 * function — no IO, no DB. The orchestrator (`src/lib/course/submitBaseline`)
 * imports it; nothing scoring-side depends on course types.
 *
 * Placement runs before XP, because XP uses the starting tier rather than
 * each grading's own `conceptTier`. The LLM emits only quality; the tier
 * comes from the Harness's placement decision (issue #94).
 *
 * Defence-in-depth: the LLM schema's superRefine already enforces
 * `conceptTier` is in scope, but a second assertion here makes the
 * orchestration fail loud if a future schema regression slips through.
 * Out-of-scope tier values throw — they indicate a bug in the validation
 * path, not a recoverable model error.
 *
 * @throws if any merged grading's `conceptTier` is outside `scopeTiers`,
 *   or any `baselineQuestions` entry has no matching grading.
 */
export function scoreBaseline(params: ScoreBaselineParams): ScoreBaselineResult {
  // `Set` for O(1) scope lookups. The cast to `number` is safe — `scopeTiers`
  // is `readonly number[]` and `Set` widens to `Set<number>` cleanly.
  const scope = new Set<number>(params.scopeTiers);

  // Mechanical MC gradings are authoritative — the LLM never grades MC
  // answers (the harness owns the score). The wire schema still requires the
  // model to emit a grading per question id, but for MC question ids we
  // discard the model's entry and keep the mechanical one. Ordering the
  // `Map` so mechanical entries land LAST makes them win the last-write
  // dedupe. Using `Map` constructed from a flat array keeps the function
  // pure — no per-element mutation.
  const byId = new Map<string, StoredGrading>(
    [...params.parsed.gradings, ...params.mechanicalGradings].map((g) => [g.questionId, g]),
  );

  // Each grading keeps its question's tier beside it, for placement.
  const placed = params.baselineQuestions.map((q) => {
    const g = byId.get(q.id);
    if (!g) {
      throw new Error(`scoreBaseline: no grading for questionId ${q.id}`);
    }
    if (!scope.has(g.conceptTier)) {
      throw new Error(
        `scoreBaseline: grading for ${q.id} has conceptTier ${g.conceptTier} outside scopeTiers`,
      );
    }
    return { grading: g, questionTier: q.tier };
  });
  const merged = placed.map((p) => p.grading);

  // Placement files each grade under its question's tier. That tier was
  // fixed before the learner answered. The model's `conceptTier` is not
  // used: it is written after the model reads the answer.
  const startingTier = determineStartingTier({
    results: placed.map((p) => ({ tier: p.questionTier, qualityScore: p.grading.qualityScore })),
    scopeTiers: params.scopeTiers,
  });

  // XP boundary: tier from placement (`startingTier`), quality from grading.
  // The LLM never sees this value — it's computed deterministically here.
  const totalXp = merged.reduce((sum, g) => sum + calculateXP(startingTier, g.qualityScore), 0);

  // Free-text subtotal: same XP formula, but restricted to questions with no
  // mechanical (MC-click) grading. A question is free-text iff its id is not
  // in `mechanicalGradings` — this also correctly includes a freetext-escape
  // answer on an MC question, which is LLM-graded rather than mechanical.
  const mechanicalQids = new Set(params.mechanicalGradings.map((g) => g.questionId));
  const freeTextXp = merged.reduce(
    (sum, g) =>
      mechanicalQids.has(g.questionId) ? sum : sum + calculateXP(startingTier, g.qualityScore),
    0,
  );

  return { gradings: merged, startingTier, totalXp, freeTextXp };
}
