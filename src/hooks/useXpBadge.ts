"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { playCorrect } from "@/lib/sound";
import { deriveXpTick } from "@/lib/course/deriveXpTick";

/** The header XP badge: the server total, its pulse, and the typed-answer sound switch. */
export interface XpBadge {
  /** The server's course total; the last one seen while a refetch loads. */
  readonly xp: number;
  /** Bumped on each rise. Feeds the badge pop animation's reset key. */
  readonly pulseKey: number;
  /** The most recent rise, shown in the "+N XP" floater. */
  readonly gainAmount: number;
  /**
   * Set before a submit lands: whether its rise plays `playCorrect`. True only
   * for a typed answer. A tapped MC pick played its sound at confirm.
   */
  readonly soundOnNextRise: (play: boolean) => void;
}

/**
 * Display the server's course total in the header badge, and tick when it
 * rises. The client computes no XP: the total comes from `getState`, or from
 * a Wave turn result patched into the cached Wave state.
 *
 * `deriveXpTick` decides the tick. One sound per answer: a correct MC pick
 * plays at confirm (`useQuestionnaire`), so a rise is silent unless the
 * caller armed it for a typed answer. The arm lasts for one rise.
 */
export function useXpBadge(totalXp: number | undefined): XpBadge {
  // The last total seen; undefined until the first one lands.
  const [seenTotal, setSeenTotal] = useState<number | undefined>(undefined);
  const [pulse, setPulse] = useState({ pulseKey: 0, gainAmount: 0 });
  // A ref, not state: it never drives rendering, and a submit sets it.
  const soundOnNextRiseRef = useRef(false);

  // React's "adjust state on a prop change" pattern: compare the new total
  // with the last one during render, not in an effect, so the badge never
  // paints a stale pulse. `undefined` (a query loading) keeps the last total.
  if (totalXp !== undefined && totalXp !== seenTotal) {
    const tick = deriveXpTick(seenTotal, totalXp);
    setSeenTotal(totalXp);
    if (tick.pulse) {
      setPulse((prev) => ({ pulseKey: prev.pulseKey + 1, gainAmount: tick.gain }));
    }
  }

  // The sound is a side effect, so it runs after the rise renders. Every rise
  // spends the arm, so a later rise cannot replay an earlier answer's sound.
  useEffect(() => {
    if (pulse.pulseKey === 0) return;
    if (soundOnNextRiseRef.current) playCorrect();
    soundOnNextRiseRef.current = false;
  }, [pulse.pulseKey]);

  const soundOnNextRise = useCallback((play: boolean) => {
    soundOnNextRiseRef.current = play;
  }, []);

  return {
    xp: totalXp ?? seenTotal ?? 0,
    pulseKey: pulse.pulseKey,
    gainAmount: pulse.gainAmount,
    soundOnNextRise,
  };
}
