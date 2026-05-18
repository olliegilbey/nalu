/**
 * Wave-loop tunables.
 * - `turnCount`: fixed length of every teaching Wave (mid-turns 1…turnCount-1,
 *   close turn at turnsRemaining===0).
 * - `tierCheckInterval`: gates the close-turn tier-advancement check; smaller
 *   = more frequent advancement checks. MVP value 2 keeps integration tests
 *   fast.
 *   TODO(pre-launch): raise to ~5 once tier-progression UX is validated.
 * - `completionXp`: flat bonus on Wave close. Motivates finishing a Wave
 *   without inflating per-question XP scaling — sized at roughly a tier-5
 *   medium-quality free-text answer, so the per-Wave commitment payoff is
 *   visible without dwarfing in-Wave grading.
 */
export const WAVE = {
  turnCount: 10,
  tierCheckInterval: 2,
  completionXp: 50,
} as const;
