import { VERDICT_QUALITY_BANDS } from "@/lib/types/jsonb";
import type { QualityScore } from "@/lib/types/spaced-repetition";

/** A free-text grade: one key of `VERDICT_QUALITY_BANDS`. */
type Verdict = keyof typeof VERDICT_QUALITY_BANDS;

/**
 * The verdict band a quality score falls in. The Harness sets a free-text
 * answer's correctness from it, so correctness and XP come from the one
 * score and cannot disagree (issue #198).
 */
export function verdictForQualityScore(qualityScore: QualityScore): Verdict {
  const verdicts: readonly Verdict[] = ["correct", "partial", "incorrect"];
  const band = verdicts.find((verdict) => {
    const [lo, hi] = VERDICT_QUALITY_BANDS[verdict];
    return qualityScore >= lo && qualityScore <= hi;
  });
  // Unreachable: the bands cover 0-5 with no gaps. The throw narrows the type.
  if (band === undefined) throw new Error(`no verdict band holds qualityScore ${qualityScore}`);
  return band;
}
