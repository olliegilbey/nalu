import { describe, it, expect } from "vitest";
import { deriveWaveProgress } from "./deriveWaveProgress";

describe("deriveWaveProgress", () => {
  it("puts a fresh Wave on turn 1 with an empty bar", () => {
    // getWaveState: no learner entry yet, so all 10 turns remain.
    expect(deriveWaveProgress({ turnsRemaining: 10, turnBudget: 10, isClosed: false })).toEqual({
      currentTurn: 1,
      turnBudget: 10,
      percent: 0,
      isComplete: false,
    });
  });

  it("fills the bar with the Turns already landed, not the one in hand", () => {
    // Three learner entries landed: the learner is on turn 4, 30% done.
    expect(deriveWaveProgress({ turnsRemaining: 7, turnBudget: 10, isClosed: false })).toEqual({
      currentTurn: 4,
      turnBudget: 10,
      percent: 30,
      isComplete: false,
    });
  });

  it("puts the learner on the final turn with one turn left", () => {
    // The close turn: nine landed, and the bar stops short of full.
    expect(deriveWaveProgress({ turnsRemaining: 1, turnBudget: 10, isClosed: false })).toEqual({
      currentTurn: 10,
      turnBudget: 10,
      percent: 90,
      isComplete: false,
    });
  });

  it("shows a closed Wave complete, with a full bar", () => {
    expect(deriveWaveProgress({ turnsRemaining: 0, turnBudget: 10, isClosed: true })).toEqual({
      currentTurn: 10,
      turnBudget: 10,
      percent: 100,
      isComplete: true,
    });
  });
});
