/**
 * Structural assertion helpers for live scoping-flow smoke tests.
 *
 * WHY here and not inline in the test: these are reusable across future live
 * tests (post-submitBaseline, wave-level) and they are unit-testable against
 * fixture payloads. Keeping them separate also means a failure message names
 * the helper call site, not a buried inline expect.
 *
 * All assertions use vitest `expect` so failures produce human-readable diffs.
 */

import { expect } from "vitest";
import type { FrameworkJsonb } from "@/lib/types/jsonb";
import { baselineSchema } from "@/lib/prompts/baseline";
import { BASELINE } from "@/lib/config/tuning";

// ---------------------------------------------------------------------------
// assertFrameworkStructural
// ---------------------------------------------------------------------------

/**
 * Assert that a {@link FrameworkJsonb} meets the structural invariants Nalu
 * requires for the teaching + baseline flows to work correctly.
 *
 * Checks:
 * - Tier count is ≥3 and ≤7 (PRD §3; FRAMEWORK.minTiers/maxTiers, but we use
 *   7 not 8 here because the live tests target standard topics — adjust if needed).
 * - Every tier has a unique `number`, non-empty `name`, non-empty `description`,
 *   and at least one example concept.
 * - `baseline_scope_tiers` is non-empty and every entry is a real tier number.
 * - `estimated_starting_tier` is a real tier number.
 *
 * @param framework - The JSONB payload returned by the generateFramework router.
 */
export function assertFrameworkStructural(framework: FrameworkJsonb): void {
  // --- tier count ---
  expect(framework.tiers.length, "framework: tier count ≥ 3").toBeGreaterThanOrEqual(3);
  expect(framework.tiers.length, "framework: tier count ≤ 7").toBeLessThanOrEqual(7);

  const tierNumbers = framework.tiers.map((t) => t.number);

  // --- uniqueness ---
  const uniqueTierNumbers = new Set(tierNumbers);
  expect(uniqueTierNumbers.size, "framework: tier numbers must be unique").toBe(
    framework.tiers.length,
  );

  // --- per-tier content ---
  for (const tier of framework.tiers) {
    expect(tier.name.length, `tier ${tier.number}: name must be non-empty`).toBeGreaterThan(0);
    expect(
      tier.description.length,
      `tier ${tier.number}: description must be non-empty`,
    ).toBeGreaterThan(0);
    expect(
      tier.example_concepts.length,
      `tier ${tier.number}: must have at least one example concept`,
    ).toBeGreaterThan(0);
  }

  // --- baseline_scope_tiers is non-empty subset of tier numbers ---
  expect(
    framework.baseline_scope_tiers.length,
    "framework: baseline_scope_tiers must be non-empty",
  ).toBeGreaterThan(0);
  for (const bst of framework.baseline_scope_tiers) {
    expect(
      tierNumbers,
      `framework: baseline_scope_tiers entry ${bst} must be a real tier number`,
    ).toContain(bst);
  }

  // --- estimated_starting_tier is a real tier number ---
  expect(
    tierNumbers,
    `framework: estimated_starting_tier ${framework.estimated_starting_tier} must be a real tier number`,
  ).toContain(framework.estimated_starting_tier);
}

// ---------------------------------------------------------------------------
// assertBaselineStructural
// ---------------------------------------------------------------------------

/**
 * Assert that a baseline assessment meets the structural invariants needed for
 * the answering + grading flows.
 *
 * WHY re-parse with `baselineSchema`: the router returns `BaselineAssessment`
 * (from the lib step), but the helper needs to operate on the question fields.
 * Re-parsing narrows `unknown[]` questions to their typed union so we can
 * safely access `questionId`, `tier`, `conceptName`, `freetextRubric`.
 *
 * Note: `generateBaseline` returns `{ baseline: BaselineAssessment }` where
 * `BaselineAssessment = z.infer<typeof baselineSchema>`. We accept that type.
 *
 * @param baseline - The `baseline` field from the `generateBaseline` router result.
 * @param framework - The framework used to generate the baseline (for tier validation).
 */
export function assertBaselineStructural(
  baseline: { readonly questions: readonly unknown[] },
  framework: FrameworkJsonb,
): void {
  // Re-parse the question array through the typed schema to narrow unknown[]
  // to the union type. This mirrors the idempotency re-parse in generateBaseline.ts.
  const parsed = baselineSchema.safeParse(baseline);
  expect(parsed.success, `baseline: failed schema re-parse: ${JSON.stringify(parsed)}`).toBe(true);

  // TS now knows parsed.data exists via safeParse success guard.
  if (!parsed.success) return;

  const questions = parsed.data.questions;

  // --- question count ---
  expect(
    questions.length,
    `baseline: question count must be ≥ ${BASELINE.minQuestions}`,
  ).toBeGreaterThanOrEqual(BASELINE.minQuestions);

  // --- unique question IDs ---
  // The schema uses `id` (e.g. "b1", "b2", ...), not `questionId`.
  const ids = questions.map((q) => q.id);
  const uniqueIds = new Set(ids);
  expect(uniqueIds.size, "baseline: question IDs must be unique").toBe(questions.length);

  // --- each question's tier is within baseline_scope_tiers ---
  const scopeTiers = new Set(framework.baseline_scope_tiers);
  for (const q of questions) {
    expect(
      scopeTiers,
      `baseline: question ${q.id} has tier ${q.tier} outside baseline_scope_tiers`,
    ).toContain(q.tier);
  }

  // --- non-empty rubric and conceptName per question ---
  for (const q of questions) {
    expect(
      q.conceptName.length,
      `baseline: question ${q.id} must have non-empty conceptName`,
    ).toBeGreaterThan(0);
    expect(
      q.freetextRubric.length,
      `baseline: question ${q.id} must have non-empty freetextRubric`,
    ).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// assertIdempotency
// ---------------------------------------------------------------------------

/**
 * Assert that a repeated call returned quickly enough to prove it bypassed the
 * LLM (i.e. was served from DB cache).
 *
 * The budget is intentionally loose (200ms) to absorb Postgres round-trip and
 * testcontainer latency while still catching accidental LLM calls (which take
 * 1–30s on Cerebras free tier). The `label` is embedded in the failure message
 * so you immediately see *which* procedure was supposed to be cached.
 *
 * @param elapsedMs - Wall-clock milliseconds for the repeated call.
 * @param label - Human-readable name (e.g. `"generateBaseline(rust-ownership)"`).
 */
export function assertIdempotency(elapsedMs: number, label: string): void {
  expect(
    elapsedMs,
    `${label}: elapsed ${elapsedMs}ms ≥ 200ms — likely hit LLM instead of DB cache`,
  ).toBeLessThan(200);
}
