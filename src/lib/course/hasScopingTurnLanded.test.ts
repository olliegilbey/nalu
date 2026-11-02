import { describe, it, expect } from "vitest";
import { hasScopingTurnLanded, type ScopingTurnKind } from "./hasScopingTurnLanded";
import type { CourseState } from "./getState";
import type { ScopingQuestionnaireForClient } from "./redactQuestionnaire";
import type { FrameworkJsonb } from "@/lib/types/jsonb";

const framework: FrameworkJsonb = {
  userMessage: "Here's your ladder.",
  tiers: [{ number: 1, name: "Foundations", description: "Numbers", exampleConcepts: [] }],
  estimatedStartingTier: 1,
  baselineScopeTiers: [1],
};

const baseline: ScopingQuestionnaireForClient = {
  userMessage: "Quick check.",
  questions: [{ id: "b1", type: "free_text", prompt: "Explain" }],
  responses: [{ questionId: "b1", freetext: "Because" }],
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
    totalXp: 0,
    ...overrides,
  };
}

/** Which kinds count as landed for one state, so each test pins the whole mapping. */
function landedKinds(s: CourseState): readonly ScopingTurnKind[] {
  const kinds: readonly ScopingTurnKind[] = ["frameworkAndBaseline", "scopingClose"];
  return kinds.filter((kind) => hasScopingTurnLanded(s, kind));
}

describe("hasScopingTurnLanded", () => {
  it("reports nothing landed before the framework exists", () => {
    expect(landedKinds(state({}))).toEqual([]);
  });

  // A course framed before the merge (issue #15) can hold a framework alone.
  // The merged Turn writes both columns at once, so it has not landed.
  it("reports nothing landed for a framework with no baseline", () => {
    expect(landedKinds(state({ framework }))).toEqual([]);
  });

  it("reports the merged Turn once a baseline exists, even with answers saved", () => {
    expect(landedKinds(state({ framework, baseline }))).toEqual(["frameworkAndBaseline"]);
  });

  it("reports the scoping close only once a scoping result exists", () => {
    const closed = state({
      status: "active",
      framework,
      baseline,
      scopingResult: { closingMessage: "Ready.", startingTier: 1 },
    });
    expect(landedKinds(closed)).toEqual(["frameworkAndBaseline", "scopingClose"]);
  });
});
