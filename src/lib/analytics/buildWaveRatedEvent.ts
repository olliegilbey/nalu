/**
 * Server-side PostHog `wave_rated` payload builder. Pure and deterministic:
 * the clock and environment are passed in, so it unit-tests without either.
 *
 * Privacy: the event carries the Wave number and the star values only. No
 * course id, topic or learner text. It picks each property by name, so a
 * wider input object can never leak a field into PostHog.
 */

import type { WaveRatingStars } from "@/lib/types/waveRatingInput";
import type { EnvironmentContext } from "./environmentContext";

/** Inputs for {@link buildWaveRatedEvent}: all clock and environment values pre-read. */
export interface WaveRatedInput {
  readonly apiKey: string;
  /** The learner's anonymous user id, as on `$pageview`, so the events join. */
  readonly distinctId: string;
  readonly waveNumber: number;
  readonly stars: WaveRatingStars;
  readonly timestamp: string;
  /** `env`/`source`/`is_server`: `source` separates preview from production. */
  readonly environment: EnvironmentContext;
}

/** PostHog capture-API event body (`POST /i/v0/e/`) for one saved Wave rating. */
export interface WaveRatedEvent {
  readonly api_key: string;
  readonly event: "wave_rated";
  readonly distinct_id: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

/** Build a PostHog `wave_rated` event from one saved Wave rating. */
export function buildWaveRatedEvent(input: WaveRatedInput): WaveRatedEvent {
  const { apiKey, distinctId, waveNumber, stars, timestamp, environment } = input;
  return {
    api_key: apiKey,
    event: "wave_rated",
    distinct_id: distinctId,
    timestamp,
    properties: {
      wave_number: waveNumber,
      overall: stars.overall,
      // Each dimension rides only when the learner gave it.
      ...(stars.difficulty === undefined ? {} : { difficulty: stars.difficulty }),
      ...(stars.pacing === undefined ? {} : { pacing: stars.pacing }),
      ...(stars.usefulness === undefined ? {} : { usefulness: stars.usefulness }),
      // Anonymous capture, as on `$pageview`: no Person profile per user id.
      // `buildPageviewEvent` explains the opt-out.
      $process_person_profile: false,
      app: "nalu",
      env: environment.env,
      source: environment.source,
      is_server: environment.is_server,
    },
  };
}
