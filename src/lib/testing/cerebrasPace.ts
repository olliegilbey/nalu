/**
 * Live-smoke pacing helper for Cerebras free-tier rate limits.
 *
 * WHY: Cerebras free tier caps at ~30 RPM (≈2s between requests). The full
 * smoke run (course.live + submitBaseline.live + wave.live) fires ~27 LLM
 * calls quasi-serially across the suite. Without explicit pacing, vitest's
 * back-to-back router calls burst above 30 RPM and the SDK exhausts its
 * retry budget on the resulting 429s.
 *
 * Pair this with `LLM.maxRetries = 6` in `src/lib/config/tuning.ts`
 * (belt + braces). The retry budget handles single-call stalls; this
 * pacing prevents sustained bursts in the first place.
 *
 * Default delay: 2500ms — safely above the 30 RPM minimum spacing (2000ms)
 * with margin for clock skew and the model's response-time variance.
 *
 * Used only in `*.live.test.ts`; never in production code paths.
 */
export function pace(ms: number = 2500): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
