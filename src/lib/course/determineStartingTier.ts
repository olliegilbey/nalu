import { PROGRESSION } from "@/lib/config/tuning";
import type { QuestionGrading } from "./gradeBaseline";

/** Parameters for {@link determineStartingTier}. */
export interface DetermineStartingTierParams {
  /** Graded baseline answers — one per baseline question. */
  readonly gradings: readonly QuestionGrading[];
  /** `framework.estimatedStartingTier`, the fallback for the all-unreached case. */
  readonly estimatedStartingTier: number;
  /** `framework.baselineScopeTiers`. Defines the placement search space. */
  readonly scopeTiers: readonly number[];
}

interface TierAggregate {
  readonly sum: number;
  readonly n: number;
}

/**
 * Choose the learner's starting tier from baseline gradings.
 *
 * Pure function, no LLM. Mirrors the placement reasoning in the Rust
 * ownership UX sim (docs/ux-simulation-rust-ownership.md §5): the first
 * tier inside scope where the learner shows friction is where teaching
 * begins, because that's the first tier worth teaching rather than
 * re-teaching. "Friction" is `avgQuality < PROGRESSION.passingQualityScore`,
 * the same boundary tier-advancement uses — one threshold across the
 * learning lifecycle.
 *
 * Decision rules, applied in order:
 *
 * 1. **All unreached** — if no baseline question for any scope tier has a
 *    grading, return `estimatedStartingTier`. This is a safety net; with
 *    `BASELINE.minQuestions = 7` and generation constrained to scope, the
 *    path is unreachable in practice.
 * 2. **First friction** — walk `scopeTiers` ascending; the first tier
 *    with at least one grading AND `avgQuality < passingQualityScore`
 *    wins. Unreached tiers (n = 0) are skipped, not counted against the
 *    learner.
 * 3. **Comfortable across scope** — if every reached tier sits at or
 *    above the threshold, return `max(scopeTiers)`. The learner has
 *    outgrown the scope's lower half; start them at the top and let
 *    normal tier advancement take over.
 *
 * The result is always a tier number inside `scopeTiers` (rules 2 and 3)
 * or `estimatedStartingTier` (rule 1) — which the framework schema
 * already guarantees lies inside scope. No explicit range clamp needed.
 */
export function determineStartingTier(params: DetermineStartingTierParams): number {
  const { gradings, estimatedStartingTier, scopeTiers } = params;

  // Aggregate gradings into (sum, n) per tier. Out-of-scope gradings are
  // ignored defensively — they shouldn't exist (generateBaseline enforces
  // the scope invariant) but must not perturb placement if they do.
  const aggregates: Readonly<Record<number, TierAggregate>> = gradings
    .filter((g) => scopeTiers.includes(g.tier))
    .reduce<Readonly<Record<number, TierAggregate>>>((acc, g) => {
      const prev = acc[g.tier] ?? { sum: 0, n: 0 };
      return { ...acc, [g.tier]: { sum: prev.sum + g.quality, n: prev.n + 1 } };
    }, {});

  // Rule 1: all unreached → fallback to estimated tier.
  const anyReached = scopeTiers.some((t) => (aggregates[t]?.n ?? 0) > 0);
  if (!anyReached) return estimatedStartingTier;

  // Rule 2: first tier in ascending scope with friction.
  const ordered = [...scopeTiers].sort((a, b) => a - b);
  const friction = ordered.find((tier) => {
    const agg = aggregates[tier];
    if (!agg || agg.n === 0) return false;
    return agg.sum / agg.n < PROGRESSION.passingQualityScore;
  });
  if (friction !== undefined) return friction;

  // Rule 3: learner is solid across scope → promote to top.
  return Math.max(...scopeTiers);
}
