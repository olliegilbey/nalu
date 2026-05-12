/**
 * Unit tests for scoping invariant helpers (scopingInvariants.ts).
 *
 * WHY unit-test the helpers: if a helper silently passes a broken payload,
 * the live test gives no signal. These fixture-based tests confirm each
 * invariant actually fires.
 *
 * Strategy: build a broken fixture via spread (never mutate — immutable-data
 * rule), assert the helper throws.
 */

import { describe, it, expect } from "vitest";
import type { FrameworkJsonb } from "@/lib/types/jsonb";
import {
  assertFrameworkStructural,
  assertBaselineStructural,
  assertIdempotency,
} from "./scopingInvariants";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid three-tier framework. */
function validFramework(): FrameworkJsonb {
  return {
    topic: "Rust",
    scope_summary: "Covers tiers 1 and 2.",
    estimated_starting_tier: 1,
    baseline_scope_tiers: [1, 2],
    tiers: [
      {
        number: 1,
        name: "Foundations",
        description: "Core ownership.",
        example_concepts: ["borrow checker", "lifetimes"],
      },
      {
        number: 2,
        name: "Intermediate",
        description: "Traits.",
        example_concepts: ["traits", "generics"],
      },
      {
        number: 3,
        name: "Advanced",
        description: "Unsafe patterns.",
        example_concepts: ["unsafe", "FFI"],
      },
    ],
  };
}

/** Minimal valid baseline assessment (7 questions, tiers 1 and 2). */
function validBaseline(): { readonly questions: readonly unknown[] } {
  const questions = Array.from({ length: 7 }, (_, i) => ({
    id: `b${i + 1}`,
    tier: (i % 2) + 1, // alternates 1, 2, 1, 2, ...
    conceptName: `concept-${i + 1}`,
    type: "multiple_choice" as const,
    question: `What is concept ${i + 1}?`,
    options: { A: "opt-a", B: "opt-b", C: "opt-c", D: "opt-d" },
    correct: "A" as const,
    freetextRubric: `A good answer explains concept ${i + 1}.`,
  }));
  return { questions };
}

// ---------------------------------------------------------------------------
// assertFrameworkStructural
// ---------------------------------------------------------------------------

describe("assertFrameworkStructural", () => {
  it("passes for a valid fixture", () => {
    // Should not throw.
    expect(() => assertFrameworkStructural(validFramework())).not.toThrow();
  });

  it("throws when tier count < 3", () => {
    // Slice to 2 tiers — no mutation.
    const fw: FrameworkJsonb = { ...validFramework(), tiers: validFramework().tiers.slice(0, 2) };
    expect(() => assertFrameworkStructural(fw)).toThrow();
  });

  it("throws when tier count > 7", () => {
    // Build 8 tiers via spread.
    const extra = [4, 5, 6, 7, 8].map((n) => ({
      number: n,
      name: `Tier ${n}`,
      description: "desc",
      example_concepts: ["x"],
    }));
    const fw: FrameworkJsonb = {
      ...validFramework(),
      tiers: [...validFramework().tiers, ...extra],
    };
    expect(() => assertFrameworkStructural(fw)).toThrow();
  });

  it("throws when tier numbers are not unique", () => {
    // Override tier 3 to number 1 — duplicate.
    const [t1, t2, t3] = validFramework().tiers;
    const fw: FrameworkJsonb = {
      ...validFramework(),
      tiers: [t1!, t2!, { ...t3!, number: 1 }],
    };
    expect(() => assertFrameworkStructural(fw)).toThrow();
  });

  it("throws when a tier has an empty name", () => {
    const [t1, t2, t3] = validFramework().tiers;
    const fw: FrameworkJsonb = {
      ...validFramework(),
      tiers: [{ ...t1!, name: "" }, t2!, t3!],
    };
    expect(() => assertFrameworkStructural(fw)).toThrow();
  });

  it("throws when a tier has no example concepts", () => {
    const [t1, t2, t3] = validFramework().tiers;
    const fw: FrameworkJsonb = {
      ...validFramework(),
      tiers: [{ ...t1!, example_concepts: [] }, t2!, t3!],
    };
    expect(() => assertFrameworkStructural(fw)).toThrow();
  });

  it("throws when baseline_scope_tiers is empty", () => {
    const fw: FrameworkJsonb = { ...validFramework(), baseline_scope_tiers: [] };
    expect(() => assertFrameworkStructural(fw)).toThrow();
  });

  it("throws when baseline_scope_tiers contains a non-existent tier number", () => {
    const fw: FrameworkJsonb = { ...validFramework(), baseline_scope_tiers: [99] };
    expect(() => assertFrameworkStructural(fw)).toThrow();
  });

  it("throws when estimated_starting_tier is not a real tier number", () => {
    const fw: FrameworkJsonb = { ...validFramework(), estimated_starting_tier: 99 };
    expect(() => assertFrameworkStructural(fw)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertBaselineStructural
// ---------------------------------------------------------------------------

describe("assertBaselineStructural", () => {
  it("passes for a valid fixture", () => {
    expect(() => assertBaselineStructural(validBaseline(), validFramework())).not.toThrow();
  });

  it("throws when questions < minQuestions (7)", () => {
    // Slice to 6 questions — below the minimum.
    const fewer = { questions: validBaseline().questions.slice(0, 6) };
    expect(() => assertBaselineStructural(fewer, validFramework())).toThrow();
  });

  it("throws when a question has a tier outside baseline_scope_tiers", () => {
    // Tier 3 is not in baseline_scope_tiers [1, 2].
    const mutated = validBaseline().questions.map((q, i) =>
      i === 0 ? { ...(q as Record<string, unknown>), tier: 3 } : q,
    );
    expect(() => assertBaselineStructural({ questions: mutated }, validFramework())).toThrow();
  });

  it("throws when question IDs are not unique", () => {
    // Duplicate the first question ID onto the second question.
    const qs = validBaseline().questions as ReadonlyArray<Record<string, unknown>>;
    const mutated = qs.map((q, i) => (i === 1 ? { ...q, id: "b1" } : q));
    expect(() => assertBaselineStructural({ questions: mutated }, validFramework())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertIdempotency
// ---------------------------------------------------------------------------

describe("assertIdempotency", () => {
  it("passes when elapsed < 200ms", () => {
    expect(() => assertIdempotency(50, "generateBaseline(test)")).not.toThrow();
  });

  it("throws with the label in the message when elapsed >= 200ms", () => {
    expect(() => assertIdempotency(250, "generateBaseline(my-topic)")).toThrow(
      /generateBaseline\(my-topic\)/,
    );
  });
});
