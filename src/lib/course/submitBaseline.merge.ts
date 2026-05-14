import type { z } from "zod";
import type { baselineGradingSchema } from "@/lib/types/jsonb";
import { calculateXP } from "@/lib/scoring/xp";

/** Persisted grading shape — matches `baselineGradingSchema` in jsonbBaseline. */
export type StoredGrading = z.infer<typeof baselineGradingSchema>;

/** Inputs to the pure merge / XP step. All readonly to keep callers honest. */
export interface MergeAndComputeXpParams {
  /** LLM-side parsed close-turn payload. `gradings` may be in any order. */
  readonly parsed: {
    readonly gradings: readonly StoredGrading[];
    readonly startingTier: number;
  };
  /** Mechanical MC gradings produced by `gradeMc` (deterministic, no LLM). */
  readonly mechanicalGradings: readonly StoredGrading[];
  /** The canonical order — same as `baseline.questions.map(q => q.id)`. */
  readonly baselineQuestionIds: readonly string[];
  /** Tiers that exist in the framework. Anything outside is a contract bug. */
  readonly scopeTiers: readonly number[];
}

/** Pure output: ordered gradings + deterministic total XP. */
export interface MergeAndComputeXpResult {
  readonly gradings: readonly StoredGrading[];
  readonly totalXp: number;
}

/**
 * Merge LLM and mechanical gradings into one canonically-ordered list and
 * compute total XP for the baseline.
 *
 * Defence-in-depth: the LLM schema's superRefine already enforces
 * `startingTier` and `conceptTier` are in scope, but a second assertion
 * here makes the orchestration fail loud if a future schema regression
 * slips through. Out-of-scope tier values throw — they indicate a bug in
 * the validation path, not a recoverable model error.
 *
 * XP uses `startingTier` (placement) rather than each grading's own
 * `conceptTier`, consistent with the LLM-XP boundary (LLM emits only
 * quality; tier comes from the harness's placement decision).
 *
 * @throws if `startingTier` is outside `scopeTiers`, or any merged
 *   grading's `conceptTier` is outside `scopeTiers`, or any
 *   `baselineQuestionIds` entry has no matching grading.
 */
export function mergeAndComputeXp(params: MergeAndComputeXpParams): MergeAndComputeXpResult {
  // `Set` for O(1) scope lookups. The cast to `number` is safe — `scopeTiers`
  // is `readonly number[]` and `Set` widens to `Set<number>` cleanly.
  const scope = new Set<number>(params.scopeTiers);

  if (!scope.has(params.parsed.startingTier)) {
    throw new Error(
      `mergeAndComputeXp: startingTier ${params.parsed.startingTier} outside scopeTiers [${[...scope].join(", ")}]`,
    );
  }

  // Build the lookup with LLM entries overriding mechanical (last wins).
  // Using `Map` constructed from a flat array keeps the function pure —
  // no per-element mutation, no `immutable-data` lint warning.
  const byId = new Map<string, StoredGrading>(
    [...params.mechanicalGradings, ...params.parsed.gradings].map((g) => [g.questionId, g]),
  );

  const merged = params.baselineQuestionIds.map((qid) => {
    const g = byId.get(qid);
    if (!g) {
      throw new Error(`mergeAndComputeXp: no grading for questionId ${qid}`);
    }
    if (!scope.has(g.conceptTier)) {
      throw new Error(
        `mergeAndComputeXp: grading for ${qid} has conceptTier ${g.conceptTier} outside scopeTiers`,
      );
    }
    return g;
  });

  // XP boundary: tier from placement (`startingTier`), quality from grading.
  // The LLM never sees this value — it's computed deterministically here.
  const totalXp = merged.reduce(
    (sum, g) => sum + calculateXP(params.parsed.startingTier, g.qualityScore),
    0,
  );

  return { gradings: merged, totalXp };
}
