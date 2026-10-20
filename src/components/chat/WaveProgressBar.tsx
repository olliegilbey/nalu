import { t, tFill } from "@/i18n";
import type { WaveProgress } from "@/lib/course/deriveWaveProgress";

/**
 * Slim strip under the chat header: "Turn N of M" and a thin bar for the open
 * Wave, or "Wave complete" with a full bar once it closes. Display only:
 * `deriveWaveProgress` owns the numbers, and nothing here touches XP.
 */
export function WaveProgressBar({ progress }: { readonly progress: WaveProgress }) {
  const label = progress.isComplete
    ? t<string>("waveProgress.complete")
    : tFill("waveProgress.turn", { current: progress.currentTurn, total: progress.turnBudget });
  return (
    // A progressbar's children are presentational, so the label also rides
    // on aria-valuetext for screen readers.
    <div
      role="progressbar"
      aria-label={t<string>("waveProgress.label")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress.percent}
      aria-valuetext={label}
      className="relative z-10 flex items-center gap-3 h-8 px-4 border-b border-sumi-4/60 bg-sumi-1/70 backdrop-blur-xl"
    >
      <span className="shrink-0 font-mono text-[11px] tabular-nums tracking-wide text-fuji-gray">
        {label}
      </span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-sumi-4">
        {/* Green marks a finished Wave; blue an open one. */}
        <div
          className={
            "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none " +
            (progress.isComplete ? "bg-spring-green" : "bg-crystal")
          }
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}
