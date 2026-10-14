import { describe, expect, it, vi } from "vitest";
import type { WaveSeedInputs } from "@/lib/types/context";
import { renderTeachingSystem } from "./teaching";

// Hint mode is a module-level tuning flag, so it gets its own test file with
// the tuning mocked file-wide (a per-test mock would leak into the default-
// mode assertions in teaching.test.ts).
vi.mock("@/lib/config/tuning", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/config/tuning")>();
  return { ...orig, WAVE: { ...orig.WAVE, dueReviewInjection: "hint" } };
});

const SEED: WaveSeedInputs = {
  kind: "wave",
  courseTopic: "Economics",
  topicScope: "Supply and demand.",
  framework: {
    userMessage: "ok",
    tiers: [{ number: 1, name: "Foundations", description: "...", exampleConcepts: ["Markets"] }],
    estimatedStartingTier: 1,
    baselineScopeTiers: [1],
  },
  currentTier: 1,
  customInstructions: null,
  courseSummary: "seed",
  dueConcepts: [{ conceptId: "c-1", name: "Markets", tier: 1, lastQuality: 3 }],
  seedSource: {
    kind: "scoping_handoff",
    blueprint: { topic: "Demand", outline: ["x"], openingText: "hi", plannedConcepts: [] },
  },
};

describe("renderTeachingSystem (dueReviewInjection: hint)", () => {
  it("renders the lookup hint INSTEAD of the concept list", () => {
    const out = renderTeachingSystem(SEED);
    expect(out).toContain("<due_for_review>");
    expect(out).toContain("Call getDueConcepts for the current list");
    // The point of hint mode: due names no longer ride the static prompt.
    expect(out).not.toContain("Markets (tier 1)");
  });

  // Issue #144, audit F4: only hint mode offers the lookup, so only its
  // output contract names it.
  it("keeps the lookup call instruction in the output contract", () => {
    const out = renderTeachingSystem(SEED);
    expect(out).toContain(
      "- getDueConcepts: lists the concepts currently due for spaced-repetition review. Call it before choosing review material to weave in or quiz on.",
    );
  });

  it("renders no block when nothing is due", () => {
    const out = renderTeachingSystem({ ...SEED, dueConcepts: [] });
    expect(out).not.toContain("<due_for_review>");
  });
});
