import { describe, it, expect } from "vitest";
import { hasScopingTurnLanded, type ScopingTurnKind } from "./hasScopingTurnLanded";
import type { CourseState } from "./getState";
import type { BaselineJsonb, FrameworkJsonb } from "@/lib/types/jsonb";

const framework: FrameworkJsonb = {
  userMessage: "Here's your ladder.",
  tiers: [{ number: 1, name: "Foundations", description: "Numbers", exampleConcepts: [] }],
  estimatedStartingTier: 1,
  baselineScopeTiers: [1],
};

const baseline: BaselineJsonb = {
  userMessage: "Quick check.",
  questions: [{ id: "b1", type: "free_text", prompt: "Explain", freetextRubric: "n/a" }],
  responses: [{ questionId: "b1", freetext: "Because" }],
  gradings: [],
};

function state(overrides: Partial<CourseState>): CourseState {
  return {
    courseId: "c",
    status: "scoping",
    topic: "Linear algebra",
    clarification: null,
    framework: null,
    baseline: null,
    scopingResult: null,
    ...overrides,
  };
}

/** Which kinds count as landed for one state, so each test pins the whole mapping. */
function landedKinds(s: CourseState): readonly ScopingTurnKind[] {
  const kinds: readonly ScopingTurnKind[] = ["framework", "baseline", "scopingClose"];
  return kinds.filter((kind) => hasScopingTurnLanded(s, kind));
}

describe("hasScopingTurnLanded", () => {
  it("reports nothing landed before the framework exists", () => {
    expect(landedKinds(state({}))).toEqual([]);
  });

  it("reports the framework Turn once a framework exists", () => {
    expect(landedKinds(state({ framework }))).toEqual(["framework"]);
  });

  it("reports the baseline Turn once a baseline exists, even with answers saved", () => {
    expect(landedKinds(state({ framework, baseline }))).toEqual(["framework", "baseline"]);
  });

  it("reports the scoping close only once a scoping result exists", () => {
    const closed = state({
      status: "active",
      framework,
      baseline,
      scopingResult: { closingMessage: "Ready.", startingTier: 1 },
    });
    expect(landedKinds(closed)).toEqual(["framework", "baseline", "scopingClose"]);
  });
});
