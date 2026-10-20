import { describe, it, expect } from "vitest";
import { i18n } from "@/i18n";
import { pickHomeSuggestions } from "./pickHomeSuggestions";

/** A random source that replays `values` in order, so a pick is deterministic. */
function sequence(...values: readonly number[]): () => number {
  let call = 0;
  return () => {
    const value = values[call];
    call += 1;
    if (value === undefined) throw new Error(`random source called ${call} times`);
    return value;
  };
}

// Issue #79: the home screen shows one suggestion per kind, drawn from a larger pool.
describe("pickHomeSuggestions", () => {
  const pool = {
    language: ["conversational Japanese", "Welsh for hikers"],
    concept: ["how transformers work", "entropy", "recursion"],
  };

  it("draws one label per kind with the random source, in pool order", () => {
    expect(pickHomeSuggestions(pool, sequence(0, 0.99))).toEqual([
      { kind: "language", label: "conversational Japanese" },
      { kind: "concept", label: "recursion" },
    ]);
  });

  it("throws on a kind with no labels rather than show an empty row", () => {
    expect(() => pickHomeSuggestions({ ...pool, skill: [] }, () => 0)).toThrow(/"skill"/);
  });
});

describe("pickHomeSuggestions on the shipped pool", () => {
  const pool = i18n.home.suggestionPool;
  const kinds = ["language", "concept", "skill", "history"];

  it("offers the four kinds at least eight labels each, with no label twice", () => {
    expect(Object.keys(pool)).toEqual(kinds);
    for (const labels of Object.values(pool)) expect(labels.length).toBeGreaterThanOrEqual(8);
    const allLabels = Object.values(pool).flat();
    expect(new Set(allLabels).size).toBe(allLabels.length);
  });

  // A constant source draws the same index in every kind. A sampler that
  // ignored kinds would then repeat a kind and a label.
  it.each([0, 0.3, 0.6, 0.999])("never repeats a kind or a label (random = %f)", (value) => {
    const picks = pickHomeSuggestions(pool, () => value);
    expect(picks.map((pick) => pick.kind)).toEqual(kinds);
    expect(new Set(picks.map((pick) => pick.label)).size).toBe(kinds.length);
  });
});
