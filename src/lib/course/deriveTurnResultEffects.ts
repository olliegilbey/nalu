import type { WaveTurnResultData } from "@/lib/types/waveStream";
import type { WaveCloseResult } from "@/hooks/useWaveState";

/**
 * Pure decision half of `useWaveState`'s turn-result handling.
 *
 * Exact port of the old submitTurn onSuccess branches (the hook applies the
 * side-effects — `addXp`, `setCloseResult`, tier-up toast — from the returned
 * effects; the decisions live here). The free-text-only signal filter and its
 * skip-`mc-index` WHY comments are carried verbatim: issues #18/#21 have a
 * pending design decision on exactly those branches — do NOT change them here.
 */
export interface TurnResultEffects {
  /**
   * XP to fold into a single badge pulse. Mid-turn: free-text signal sum.
   * Close-turn: completion XP + final-turn free-text signal sum.
   */
  readonly xpGain: number;
  /** Close-turn banner payload; present only on a close-turn result. */
  readonly closeResult?: WaveCloseResult;
  /** Tier advanced to on the close turn; present only when a tier advanced. */
  readonly tierUp?: number;
}

/** Compute the effects a turn result implies. See {@link TurnResultEffects}. */
export function deriveTurnResultEffects(result: WaveTurnResultData): TurnResultEffects {
  if (result.kind === "mid-turn") {
    // Free-text XP is server-graded; sum it into one badge pulse. MC XP
    // is already counted client-side at confirm time (Composer
    // onCorrectAnswer) — skip `mc-index` signals to avoid double-counting.
    const freeTextXp = result.gradedSignals
      .filter((s) => s.kind === "free-text")
      .reduce((sum, s) => sum + s.xpAwarded, 0);
    return { xpGain: freeTextXp };
  }
  // close-turn — capture the close result + completion XP.
  const closeResult: WaveCloseResult = {
    closingMessage: result.closingMessage,
    nextWaveNumber: result.nextWaveNumber,
    completionXpAwarded: result.completionXpAwarded,
    tierAdvancedTo: result.tierAdvancedTo,
  };
  // Free-text answered on the wave's FINAL turn is server-graded too —
  // mirror the mid-turn branch and fold its XP into the same pulse as
  // completion XP. Skip `mc-index` signals: MC on the close turn is
  // already counted client-side (Composer onCorrectAnswer) — summing it
  // here would double-count.
  const freeTextXp = result.gradedSignals
    .filter((s) => s.kind === "free-text")
    .reduce((sum, s) => sum + s.xpAwarded, 0);
  return {
    xpGain: result.completionXpAwarded + freeTextXp,
    closeResult,
    ...(result.tierAdvancedTo !== null ? { tierUp: result.tierAdvancedTo } : {}),
  };
}
