"use client";

import { useCallback, useEffect, useState } from "react";
import { playCorrect } from "@/lib/sound";

/**
 * Per-course XP counter, backed by localStorage.
 *
 * Nalu's authoritative XP lives server-side; this hook is a *display* counter
 * for the header badge. It accumulates XP gained during the session — exact
 * `calculateMcXp` amounts for correct MC answers (client-side) plus
 * server-graded free-text / wave-completion XP — and persists the running
 * total per course so it survives wave-to-wave navigation and reload.
 *
 * It is NOT a source of truth and may drift from the server's totals.
 */
export interface UseCourseXpResult {
  /** Running XP total for the course. */
  readonly xp: number;
  /** Bumped on every `addXp` — feeds the badge pop animation's reset key. */
  readonly pulseKey: number;
  /** Amount of the most recent gain — shown in the "+N XP" floater. */
  readonly gainAmount: number;
  /** Add XP. Non-positive / non-finite amounts are ignored (no pulse, no write). */
  readonly addXp: (amount: number) => void;
}

/** localStorage key for a course's running XP total. */
const keyFor = (courseId: string): string => `nalu:course:${courseId}:xp`;

/** Read the persisted total. SSR-safe; returns 0 off the browser or on error. */
function readStored(courseId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(keyFor(courseId));
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * @param courseId - Course the counter is scoped to.
 */
export function useCourseXp(courseId: string): UseCourseXpResult {
  const [xp, setXp] = useState(0);
  const [pulseKey, setPulseKey] = useState(0);
  const [gainAmount, setGainAmount] = useState(0);

  // Hydrate from localStorage after mount. `useState(0)` keeps SSR and the
  // first client render identical (no hydration mismatch); the effect then
  // swaps in the stored value. Mirrors the localStorage-hydration pattern in
  // `EmptyState.tsx` / `Composer.tsx`.
  useEffect(() => {
    setXp(readStored(courseId));
  }, [courseId]);

  const addXp = useCallback(
    (amount: number) => {
      if (!Number.isFinite(amount) || amount <= 0) return;
      const rounded = Math.round(amount);
      // A positive amount that rounds to 0 (e.g. 0.4) is not a whole-XP gain —
      // skip the pulse and the redundant write, per the `addXp` contract.
      if (rounded <= 0) return;
      // Every confirmed XP gain plays the correct-answer sound. Centralised
      // here (rather than at each call site) so the badge animation and the
      // sound stay coupled: MC answers, free-text grading, and wave-completion
      // XP all flow through `addXp`. The Composer no longer plays it directly.
      playCorrect();
      setXp((prev) => {
        const next = prev + rounded;
        if (typeof window !== "undefined") {
          try {
            window.localStorage.setItem(keyFor(courseId), String(next));
          } catch {
            /* quota / disabled — ignore */
          }
        }
        return next;
      });
      setGainAmount(rounded);
      setPulseKey((k) => k + 1);
    },
    [courseId],
  );

  return { xp, pulseKey, gainAmount, addXp };
}
