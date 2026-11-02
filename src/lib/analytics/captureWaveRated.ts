import { after } from "next/server";
import { getEnv } from "@/lib/config";
import { errorLogLine } from "@/lib/security/errorLogLine";
import type { WaveRatingStars } from "@/lib/types/waveRatingInput";
import { buildWaveRatedEvent } from "./buildWaveRatedEvent";
import { getServerEnvironmentContext } from "./environmentContext";
import { sendPostHogEvent } from "./sendPostHogEvent";

/**
 * Server-side `wave_rated` capture to PostHog EU, one per saved Wave rating.
 * `saveWaveRating` calls it after the upsert commits.
 *
 * It schedules the send with Next's `after`, so the send runs once the
 * response is out and never slows the save. It never throws: an analytics
 * failure must leave the save intact. With no `POSTHOG_KEY`, it sends nothing.
 *
 * `after` throws outside a Next request scope, and `createCaller` tests have
 * none. So the `after` call stays in this module, and router tests mock it.
 */
export function captureWaveRated(input: {
  readonly userId: string;
  readonly waveNumber: number;
  readonly stars: WaveRatingStars;
}): void {
  try {
    const apiKey = getEnv().POSTHOG_KEY;
    if (!apiKey) return;
    // Build now, while the request runs; only the send waits for `after`.
    const event = buildWaveRatedEvent({
      apiKey,
      distinctId: input.userId,
      waveNumber: input.waveNumber,
      stars: input.stars,
      timestamp: new Date().toISOString(),
      environment: getServerEnvironmentContext(),
    });
    after(() => sendPostHogEvent(event));
  } catch (error) {
    // No request scope, or no env: the event is lost, the save stands. The
    // line is content-free: the Wave number and the error's name only.
    console.error(
      errorLogLine("[wave-rated] capture not scheduled", { waveNumber: input.waveNumber }, error),
    );
  }
}
