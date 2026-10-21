/** What the Wave progress indicator shows: the label's numbers and the bar's fill. */
export interface WaveProgress {
  /** The 1-based Turn the learner is on, at most `turnBudget`. */
  readonly currentTurn: number;
  readonly turnBudget: number;
  /** Share of the budget whose Turns have landed, a whole number 0-100. */
  readonly percent: number;
  readonly isComplete: boolean;
}

/**
 * Derive the Wave progress indicator from the server's turn counts. Pure.
 * Null until `wave.getState` resolves: `useWaveState` reports both counts null
 * until then.
 *
 * `turnsRemaining` comes from `getWaveState`: the budget minus the Turns whose
 * reply is saved. So `turnBudget - turnsRemaining` Turns have landed, and the
 * learner is on the next one, capped at the budget. The cap holds the label
 * at "Turn M of M" if the budget drops under an open Wave.
 */
export function deriveWaveProgress(input: {
  readonly turnsRemaining: number | null;
  readonly turnBudget: number | null;
  readonly isClosed: boolean;
}): WaveProgress | null {
  const { turnsRemaining, turnBudget, isClosed } = input;
  if (turnsRemaining === null || turnBudget === null) return null;
  if (isClosed) {
    return { currentTurn: turnBudget, turnBudget, percent: 100, isComplete: true };
  }
  const landed = turnBudget - turnsRemaining;
  return {
    currentTurn: Math.min(landed + 1, turnBudget),
    turnBudget,
    // Whole percent: a budget that does not divide 100 gives a clean
    // aria-valuenow and bar width.
    percent: Math.round((landed / turnBudget) * 100),
    isComplete: false,
  };
}
