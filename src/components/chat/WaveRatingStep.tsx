"use client";

import { useId } from "react";
import { Star } from "lucide-react";
import { t, tFill } from "@/i18n";
import { cn } from "@/lib/utils";
import { WAVE_RATING_STAR_COUNT } from "@/lib/types/waveRatingInput";
import {
  showsWaveRatingDetails,
  type WaveRatingDraft,
  type WaveRatingPrompt,
} from "@/lib/wave-rating/deriveWaveRatingSave";

/** Star values in display order: 1 to `WAVE_RATING_STAR_COUNT`. More is better. */
const STAR_VALUES = Array.from({ length: WAVE_RATING_STAR_COUNT }, (_, i) => i + 1);

/**
 * The detail prompts, in display order under the overall prompt. Difficulty
 * and pacing ask how well each suited the learner, so 5 stars means "just right".
 */
const DETAIL_PROMPTS: readonly { readonly prompt: WaveRatingPrompt; readonly label: string }[] = [
  { prompt: "difficulty", label: "waveRating.difficultyPrompt" },
  { prompt: "pacing", label: "waveRating.pacingPrompt" },
  { prompt: "usefulness", label: "waveRating.usefulnessPrompt" },
];

/** Props of {@link WaveRatingStep}: the stars so far and a setter, from `useWaveRating`. */
interface WaveRatingStepProps {
  readonly stars: WaveRatingDraft;
  readonly onChange: (prompt: WaveRatingPrompt, stars: number) => void;
}

/**
 * The rating step on a closed Wave, above the move-on button. It asks the
 * overall prompt first. Once overall holds a value, the difficulty, pacing
 * and usefulness prompts appear under it. Every prompt is optional: move-on
 * stays live throughout.
 */
export function WaveRatingStep({ stars, onChange }: WaveRatingStepProps) {
  // One row per prompt, the label beside its stars, so the footer stays
  // compact on a phone. The shared width lines the stars up across rows.
  return (
    <div className="mx-auto mb-3 w-full max-w-sm">
      <StarPrompt
        label={t<string>("waveRating.overallPrompt")}
        value={stars.overall}
        onRate={(n) => onChange("overall", n)}
      />
      {showsWaveRatingDetails(stars) && (
        <div className="animate-message-in">
          {DETAIL_PROMPTS.map(({ prompt, label }) => (
            <StarPrompt
              key={prompt}
              label={t<string>(label)}
              value={stars[prompt]}
              onRate={(n) => onChange(prompt, n)}
            />
          ))}
        </div>
      )}
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
    <div role="radiogroup" aria-labelledby={labelId} className="flex items-center gap-3">
      <p id={labelId} className="min-w-0 flex-1 text-[13px] leading-tight text-fuji-gray">
        {label}
      </p>
      <div className="flex shrink-0">
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
