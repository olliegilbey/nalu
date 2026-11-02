"use client";

import { useId } from "react";
import { Star } from "lucide-react";
import { t, tFill } from "@/i18n";
import { cn } from "@/lib/utils";
import { WAVE_RATING_STAR_COUNT } from "@/lib/types/waveRatingInput";
import type { WaveRatingDraft } from "@/lib/wave-rating/deriveWaveRatingSave";

/** Star values in display order: 1 to `WAVE_RATING_STAR_COUNT`. More is better. */
const STAR_VALUES = Array.from({ length: WAVE_RATING_STAR_COUNT }, (_, i) => i + 1);

/** Props of {@link WaveRatingStep}: the stars so far and a setter, from `useWaveRating`. */
interface WaveRatingStepProps {
  readonly stars: WaveRatingDraft;
  readonly onChange: (patch: WaveRatingDraft) => void;
}

/**
 * The rating step on a closed Wave, above the move-on button. Today it asks
 * one overall prompt. Every prompt is optional: move-on stays live throughout.
 */
export function WaveRatingStep({ stars, onChange }: WaveRatingStepProps) {
  return (
    <div className="mb-3">
      <StarPrompt
        label={t<string>("waveRating.overallPrompt")}
        value={stars.overall}
        onRate={(overall) => onChange({ overall })}
      />
    </div>
  );
}

/**
 * One prompt: a labelled radio group of stars. Native radio inputs give
 * arrow-key moves, and each announces its star count to a screen reader.
 * A tap sets the value; a tap on another star changes it; nothing clears it.
 */
function StarPrompt({
  label,
  value,
  onRate,
}: {
  readonly label: string;
  readonly value: number | undefined;
  readonly onRate: (stars: number) => void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col items-center gap-1">
      <p id={labelId} className="text-[13px] text-fuji-gray">
        {label}
      </p>
      <div className="flex">
        {STAR_VALUES.map((n) => (
          <label key={n} className="cursor-pointer p-1">
            <input
              type="radio"
              name={id}
              value={n}
              checked={value === n}
              onChange={() => onRate(n)}
              aria-label={tFill("waveRating.star", { n })}
              className="peer sr-only"
            />
            {/* Filled up to the chosen star, so the row reads as a score. */}
            <Star
              aria-hidden
              strokeWidth={1.5}
              className={cn(
                "h-7 w-7 rounded-sm transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-crystal",
                value !== undefined && n <= value ? "fill-carp text-carp" : "text-fuji-gray",
              )}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
