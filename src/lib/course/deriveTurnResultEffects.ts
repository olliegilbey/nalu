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
   * True when a typed answer earned XP this Turn, so the badge's tick plays
   * `playCorrect`. A correct MC pick already played its sound at confirm.
   */
  readonly typedAnswerEarnedXp: boolean;
  /** Close-turn banner payload; present only on a close-turn result. */
  readonly closeResult?: WaveCloseResult;
  /** Tier advanced to on the close turn; present only when a tier advanced. */
  readonly tierUp?: number;
}

/**
 * Decide the tick's sound, close banner and tier-up toast for a turn result.
 *
 * Pure: the caller owns the side-effects (sound, close state, toast). The
 * badge reads the result's `totalXp`, never a sum of signals. The turn
 * result carries no per-answer verdict (issues #219, #242), so a `free-text`
 * signal with XP stands in for "the server graded a typed answer correct".
 * Partial credit earns XP too, so it sounds as well.
 */
export function deriveTurnResultEffects(result: WaveTurnResultData): TurnResultEffects {
  const typedAnswerEarnedXp = result.gradedSignals.some(
    (s) => s.kind === "free-text" && s.xpAwarded > 0,
  );
  if (result.kind === "mid-turn") return { typedAnswerEarnedXp };
  // close-turn: capture the close result for the move-on banner.
  const closeResult: WaveCloseResult = {
    closingMessage: result.closingMessage,
    nextWaveNumber: result.nextWaveNumber,
    completionXpAwarded: result.completionXpAwarded,
    tierAdvancedTo: result.tierAdvancedTo,
  };
  return {
    typedAnswerEarnedXp,
    closeResult,
    // Omit the key entirely when no tier advanced, so callers test presence.
    ...(result.tierAdvancedTo !== null ? { tierUp: result.tierAdvancedTo } : {}),
  };
}
