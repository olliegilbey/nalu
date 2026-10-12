import type { WaveTurnResultData } from "@/lib/types/waveStream";

/**
 * Close-turn result the page surfaces after the final Wave turn lands.
 *
 * Trimmed projection of `ExecuteWaveCloseResult` — only the fields the page
 * needs to render the post-close banner + move-on CTA.
 */
export interface WaveCloseResult {
  readonly closingMessage: string;
  readonly nextWaveNumber: number;
  readonly completionXpAwarded: number;
  readonly tierAdvancedTo: number | null;
}

/** Client-side effects one Wave turn result implies; the caller applies them. */
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

/**
 * Decide the badge XP, close banner and tier-up toast for a turn result.
 *
 * Pure: the caller owns the side-effects (badge XP, close state, toast).
 * The free-text-only signal filter is deliberate. The Composer awards every
 * correct MC answer at answer time, once per question, whether confirmed or
 * typed verbatim (issues #18, #21). Counting `mc-index` here would double it.
 */
export function deriveTurnResultEffects(result: WaveTurnResultData): TurnResultEffects {
  if (result.kind === "mid-turn") {
    // Free-text XP is server-graded; sum it into one badge pulse. MC XP
    // is already counted client-side at answer time (Composer
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
  // Free-text answered on the Wave's FINAL turn is server-graded too —
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
    // Omit the key entirely when no tier advanced, so callers test presence.
    ...(result.tierAdvancedTo !== null ? { tierUp: result.tierAdvancedTo } : {}),
  };
}
