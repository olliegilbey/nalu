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

  it("caps the turn at the budget when more turns landed than it allows", () => {
    // A budget lowered under an open Wave: getWaveState clamps turnsRemaining
    // at 0, so the label must not read "Turn 4 of 3".
    expect(deriveWaveProgress({ turnsRemaining: 0, turnBudget: 3, isClosed: false })).toEqual({
      currentTurn: 3,
      turnBudget: 3,
      percent: 100,
      isComplete: false,
    });
  });

  it("rounds the bar to a whole percent", () => {
    // One of three landed: 33.33…% rounds to 33.
    expect(deriveWaveProgress({ turnsRemaining: 2, turnBudget: 3, isClosed: false })).toEqual({
      currentTurn: 2,
      turnBudget: 3,
      percent: 33,
      isComplete: false,
    });
  });

  it("shows nothing until the server's counts arrive", () => {
    // useWaveState reports both counts null until wave.getState resolves.
    expect(deriveWaveProgress({ turnsRemaining: null, turnBudget: null, isClosed: false })).toBe(
      null,
    );
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
