/**
 * Server-side PostHog `$pageview` payload builder. Pure and deterministic — all
 * request-derived inputs are passed in so it unit-tests without a request/clock.
 *
 * Geo comes from the `$ip` property: PostHog's GeoIP uses it in preference to
 * the connection IP, which is why capturing server-side (real client IP) beats a
 * reverse proxy (PostHog Cloud would geolocate our server). See the spec's
 * Revision section for why.
 */

import type { EnvironmentContext } from "./environmentContext";

/** UTM query params PostHog recognises for attribution. */
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

/** Inputs for {@link buildPageviewEvent} — all request/clock values pre-extracted. */
export interface PageviewInput {
  readonly apiKey: string;
  readonly distinctId: string;
  readonly url: string;
  readonly referrer: string | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly timestamp: string;
  /** `env`/`source`/`is_server` — `source` separates preview from production. */
  readonly environment: EnvironmentContext;
}

/** PostHog capture-API event body (`POST /i/v0/e/`). */
export interface PageviewEvent {
  readonly api_key: string;
  readonly event: "$pageview";
  readonly distinct_id: string;
  readonly timestamp: string;
  readonly properties: Record<string, string | boolean>;
}

/** Hostname of a URL, or null if it doesn't parse (referrers can be malformed). */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Build a PostHog `$pageview` event from pre-extracted request values. */
export function buildPageviewEvent(input: PageviewInput): PageviewEvent {
  const { apiKey, distinctId, url, referrer, userAgent, ip, timestamp, environment } = input;
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();

  const properties: Record<string, string | boolean> = {
    $current_url: url,
    // Fall back to the raw url if it didn't parse — never drop the event.
    $pathname: parsed?.pathname ?? url,
    // Anonymous capture: API events are *identified* by default, so without
    // this opt-out every anon user id would mint a Person profile in the
    // shared PostHog project (privacy expectation broken + billed at the
    // higher identified-event rate). The event keeps its distinct_id either
    // way, so joining PostHog sessions to DB courses still works.
    $process_person_profile: false,
    app: "nalu",
    // env/source/is_server: `source` (production|preview|local) is what you
    // filter on to keep preview-deploy test data out of production analytics.
    env: environment.env,
    source: environment.source,
    is_server: environment.is_server,
  };

  if (ip) properties.$ip = ip;
  if (userAgent) properties.$raw_user_agent = userAgent;
  if (referrer) {
    properties.$referrer = referrer;
    const domain = hostnameOf(referrer);
    if (domain) properties.$referring_domain = domain;
  }
  if (parsed) {
    for (const key of UTM_KEYS) {
      const value = parsed.searchParams.get(key);
      if (value) properties[key] = value;
    }
  }

  return { api_key: apiKey, event: "$pageview", distinct_id: distinctId, timestamp, properties };
}
