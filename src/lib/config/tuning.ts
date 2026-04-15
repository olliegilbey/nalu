import type { QualityScore } from "@/lib/types/spaced-repetition";

/**
 * Single source of truth for every algorithm tunable in Nalu.
 *
 * If you want to adjust learning difficulty, XP rewards, spaced repetition
 * aggressiveness, or tier advancement strictness — this is the only file
 * you edit. Nothing else in the codebase should hardcode these values.
 *
 * Each export documents the source of its defaults so tweaks can be made
 * with full context.
 */

/**
 * SM-2 spaced repetition parameters.
 *
 * Source: SuperMemo SM-2 (Woźniak 1987). The EF adjustment formula is
 *   EF' = EF + (efDelta.a - (5 - q) * (efDelta.b + (5 - q) * efDelta.c))
 * clamped below at `easinessFactorFloor`.
 *
 * Intervals (in days) grow per the three-stage schedule:
 *   rep 0 → firstSuccessInterval
 *   rep 1 → secondSuccessInterval
 *   rep 2+ → round(previousInterval × oldEF)
 *
 * On failure the repetition count resets to 0 and the interval collapses
 * to `failureInterval`.
 */
export const SM2 = {
  // SM-2 canonical default EF (Woźniak 1987). Starting memory stability
  // for a never-reviewed card.
  initialEasinessFactor: 2.5,
  // SM-2 canonical EF floor. Prevents EF collapse under repeated failure,
  // which would otherwise lock a concept into daily reviews forever.
  easinessFactorFloor: 1.3,
  // Stage-1 interval after first success: reinforce the next day.
  firstSuccessInterval: 1,
  // Stage-2 interval after second success. SM-2 canonical jump to a week.
  secondSuccessInterval: 6,
  // On failure the schedule collapses to tomorrow. Retention-focused; also
  // anti-gaming — a learner can't "skip" a card by bombing it once.
  failureInterval: 1,
  // Coefficients in the SM-2 EF-adjustment formula. Changing these tunes
  // how aggressively EF reacts to quality. Source: SM-2 spec.
  efDelta: { a: 0.1, b: 0.08, c: 0.02 },
} as const;

/**
 * XP reward configuration. Deterministic and hidden from the LLM — this is
 * the anti-gaming boundary. XP = round(tier × basePerTier × qualityMultiplier).
 *
 * Quality multipliers reward depth of understanding, not just correctness.
 * The 0-for-q1 rule punishes confident wrong answers more than silence.
 */
export const XP = {
  // PRD baseline. XP per tier is linear (tier × basePerTier) so progression
  // rewards stay predictable and auditable by the learner.
  basePerTier: 10,
  // Multiplier table per quality score. Q1 floors XP to 0 to deny rewards
  // for confident wrong answers (anti-gaming). Q5 pays 1.5x to reward
  // teach-level understanding without being so generous it distorts
  // progression velocity.
  qualityMultipliers: {
    0: 0, // no engagement / nonsensical — no reward
    1: 0, // wrong with clear misunderstanding — no reward (anti-gaming)
    2: 0.25, // partial understanding — token reward
    3: 0.75, // correct but uncertain — standard reward (minimum pass)
    4: 1, // correct and clear — full reward
    5: 1.5, // could teach it — bonus, but bounded
  },
} as const satisfies {
  readonly basePerTier: number;
  readonly qualityMultipliers: Readonly<Record<QualityScore, number>>;
};

/**
 * Tier advancement rules. Both conditions must be satisfied to unlock the
 * next tier. The minimum concept count is an anti-gaming measure — it
 * prevents a learner (or a broken LLM) from rushing through a tier with
 * only one or two easy concepts.
 */
export const PROGRESSION = {
  // Q>=3 is the "passing" boundary (see qualityScoreSchema docs). Concepts
  // at 2 or below count as unmastered for tier advancement purposes.
  passingQualityScore: 3,
  // Anti-gaming: a learner cannot advance a tier on 1-2 lucky concepts.
  // Forces breadth before progression.
  minimumConceptsPerTier: 5,
  // 80% mastery required. Balances "don't advance half-cooked" against
  // "don't trap learners on one stubborn concept." PRD-tunable.
  passingRatio: 0.8,
} as const;

/**
 * LLM transport defaults. Applied in `src/lib/llm/generate.ts` to every
 * structured / chat call unless the caller overrides.
 *
 * `defaultTemperature` favours consistency over creativity — a pedagogical
 * tutor should explain the same concept the same way twice. Individual
 * flows (e.g. creative framing) may override upward.
 *
 * `maxRetries` bounds transient-failure retries (timeouts, 5xx) for
 * every call. The AI SDK handles JSON-parse repair on structured
 * outputs internally — no separate budget.
 */
/**
 * Proficiency-framework generation bounds. Consumed by
 * `src/lib/prompts/framework.ts` (prompt instructions + Zod schema) so the
 * two never drift. Tier counts are PRD-sourced; per-item character caps are
 * defence-in-depth — a runaway LLM could otherwise emit multi-kilobyte
 * tiers and exhaust the context window on the next turn.
 */
export const FRAMEWORK = {
  // PRD §3: "3-8 tiers generated per topic (flexible by breadth)".
  minTiers: 3,
  maxTiers: 8,
  // PRD §4.1: each tier carries example concepts; baseline generation
  // (next flow) uses these to spread 7–9 questions across tiers. 4–7
  // gives baseline enough seeds without bloating the stored framework.
  minExampleConceptsPerTier: 4,
  maxExampleConceptsPerTier: 7,
  // Defence-in-depth character caps. The prompt asks for concise fields;
  // the schema enforces it. Chosen to comfortably fit any reasonable
  // tier label / one-to-two-sentence description / concept phrase while
  // refusing pathological output.
  tierNameMaxChars: 80,
  tierDescriptionMaxChars: 400,
  exampleConceptMaxChars: 120,
} as const;

export const LLM = {
  // Low temp → consistent explanations + predictable XML tag emission.
  // PRD-tunable; raise per-flow only where variety aids learning.
  defaultTemperature: 0.3,
  // Transport retry budget for transient errors. Used by both structured
  // and chat calls so resilience is uniform.
  maxRetries: 3,
} as const;
