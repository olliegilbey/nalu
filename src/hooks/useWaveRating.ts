"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { formatMutationError } from "@/lib/errors";
import { deriveWaveRatingSave, type WaveRatingDraft } from "@/lib/wave-rating/deriveWaveRatingSave";
import { t } from "@/i18n";

/** Return shape of {@link useWaveRating}: the step's stars, a setter, and the move-on save. */
export interface UseWaveRatingResult {
  /** The stars tapped so far. Blank on every visit: nothing reads a saved rating back. */
  readonly stars: WaveRatingDraft;
  /** Set one or more prompts. A tap on another star replaces the value. */
  readonly setStars: (patch: WaveRatingDraft) => void;
  /** Save the stars, if the learner gave an overall rating. Never waits for the save. */
  readonly submit: () => void;
}

/**
 * Hold one closed Wave's rating stars and save them on move-on.
 *
 * `deriveWaveRatingSave` decides what to send; this hook keeps only React
 * state and the mutation. The failed-save toast sits in the `useMutation`
 * options, not the `mutate` call: move-on navigates at once, and per-call
 * callbacks do not run after the component unmounts.
 */
export function useWaveRating(courseId: string, waveNumber: number): UseWaveRatingResult {
  const trpc = useTRPC();
  const [stars, setStarsState] = useState<WaveRatingDraft>({});

  const save = useMutation(
    trpc.wave.saveRating.mutationOptions({
      onError: (err) => {
        // No retry: the learner has moved on, so the toast names the rating.
        toast.error(t("waveRating.saveFailed"), { description: formatMutationError(err) });
      },
    }),
  );

  return {
    stars,
    setStars: (patch) => setStarsState((prev) => ({ ...prev, ...patch })),
    submit: () => {
      const input = deriveWaveRatingSave({ courseId, waveNumber, stars });
      if (input) save.mutate(input);
    },
  };
}
