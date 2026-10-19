/** What the Wave progress indicator shows: the label's numbers and the bar's fill. */
export interface WaveProgress {
  /** The 1-based Turn the learner is on. */
  readonly currentTurn: number;
  readonly turnBudget: number;
  /** Share of the budget whose Turns have landed, 0-100. */
  readonly percent: number;
  readonly isComplete: boolean;
}

/**
 * Derive the Wave progress indicator from the server's turn counts. Pure.
 *
 * `turnsRemaining` comes from `getWaveState`: the budget minus the Turns whose
 * reply is saved. So `turnBudget - turnsRemaining` Turns have landed, and the
 * learner is on the next one. Only the close turn closes a Wave, so an open
 * Wave always has at least one Turn left.
 */
export function deriveWaveProgress(input: {
  readonly turnsRemaining: number;
  readonly turnBudget: number;
  readonly isClosed: boolean;
}): WaveProgress {
  if (input.isClosed) {
    return {
      currentTurn: input.turnBudget,
      turnBudget: input.turnBudget,
      percent: 100,
      isComplete: true,
    };
  }
  const landed = input.turnBudget - input.turnsRemaining;
  return {
    currentTurn: landed + 1,
    turnBudget: input.turnBudget,
    percent: (landed / input.turnBudget) * 100,
    isComplete: false,
  };
}
