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
 * - `baselineScopeTiers` is non-empty and every entry is a real tier number.
 * - `estimatedStartingTier` is a real tier number.
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
      tier.exampleConcepts.length,
      `tier ${tier.number}: must have at least one example concept`,
    ).toBeGreaterThan(0);
  }

  // --- baselineScopeTiers is non-empty subset of tier numbers ---
  expect(
    framework.baselineScopeTiers.length,
    "framework: baselineScopeTiers must be non-empty",
  ).toBeGreaterThan(0);
  for (const bst of framework.baselineScopeTiers) {
    expect(
      tierNumbers,
      `framework: baselineScopeTiers entry ${bst} must be a real tier number`,
    ).toContain(bst);
  }

  // --- estimatedStartingTier is a real tier number ---
  expect(
    tierNumbers,
    `framework: estimatedStartingTier ${framework.estimatedStartingTier} must be a real tier number`,
  ).toContain(framework.estimatedStartingTier);
}

// ---------------------------------------------------------------------------
// assertBaselineStructural
// ---------------------------------------------------------------------------

/**
 * Assert that a baseline assessment meets the structural invariants needed for
 * the answering + grading flows.
 *
 * Accepts a `BaselineTurn` (the new wire/return shape from generateBaseline):
 * `{ userMessage, questions: { questions: [...] } }`.
 *
 * @param baseline - The `baseline` field from the `generateBaseline` router result.
 * @param framework - The framework used to generate the baseline (for tier validation).
 */
export function assertBaselineStructural(
  baseline: { readonly questions: { readonly questions: readonly unknown[] } },
  framework: FrameworkJsonb,
): void {
  const questions = baseline.questions.questions as ReadonlyArray<{
    readonly id: string;
    readonly tier?: number;
    readonly conceptName?: string;
    readonly freetextRubric?: string;
  }>;

  // --- question count ---
  expect(
    questions.length,
    `baseline: question count must be ≥ ${BASELINE.minQuestions}`,
  ).toBeGreaterThanOrEqual(BASELINE.minQuestions);

  // --- unique question IDs ---
  const ids = questions.map((q) => q.id);
  const uniqueIds = new Set(ids);
  expect(uniqueIds.size, "baseline: question IDs must be unique").toBe(questions.length);

  // --- each question's tier is within baselineScopeTiers ---
  const scopeTiers = new Set(framework.baselineScopeTiers);
  for (const q of questions) {
    expect(
      scopeTiers,
      `baseline: question ${q.id} has tier ${q.tier} outside baselineScopeTiers`,
    ).toContain(q.tier);
  }

  // --- non-empty rubric and conceptName per question ---
  for (const q of questions) {
    expect(
      (q.conceptName ?? "").length,
      `baseline: question ${q.id} must have non-empty conceptName`,
    ).toBeGreaterThan(0);
    expect(
      (q.freetextRubric ?? "").length,
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
