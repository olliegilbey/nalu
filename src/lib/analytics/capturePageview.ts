import { buildPageviewEvent } from "./buildPageviewEvent";
import { getServerEnvironmentContext } from "./environmentContext";

/**
 * Server-side `$pageview` capture to PostHog EU. Called from `src/proxy.ts` via
 * `event.waitUntil`, so it runs after the response is sent and must never throw
 * — analytics failures cannot break page delivery.
 *
 * Sends direct to PostHog (not a reverse proxy) with the real client IP as
 * `$ip`, so PostHog Cloud's GeoIP resolves the visitor's location rather than
 * our server's. See the spec's Revision section.
 */

/** PostHog EU single-event capture endpoint. */
const CAPTURE_URL = "https://eu.i.posthog.com/i/v0/e/";

/** Abort a hung capture — it runs in `waitUntil`, so an unbounded request
 * would keep the invocation alive for best-effort analytics. */
const CAPTURE_TIMEOUT_MS = 5_000;

/** Extract the originating client IP (first hop) from an `x-forwarded-for` value. */
function clientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  return xff ? (xff.split(",")[0]?.trim() ?? null) : null;
}

/** Fire-and-forget a `$pageview` for one navigation. Best-effort; never throws. */
export async function capturePageview(input: {
  readonly apiKey: string;
  readonly distinctId: string;
  readonly url: string;
  readonly headers: Headers;
  readonly timestamp: string;
}): Promise<void> {
  try {
    const event = buildPageviewEvent({
      apiKey: input.apiKey,
      distinctId: input.distinctId,
      url: input.url,
      referrer: input.headers.get("referer"),
      userAgent: input.headers.get("user-agent"),
      ip: clientIp(input.headers),
      timestamp: input.timestamp,
      environment: getServerEnvironmentContext(),
    });
    const response = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    // `fetch` only rejects on network errors — a bad key or PostHog outage
    // returns 4xx/5xx "successfully". Log it (greppable, like the proxy's
    // auth-failure log) so production analytics can't die silently.
    if (!response.ok) {
      console.error(`[capturePageview] PostHog capture failed: HTTP ${response.status}`);
    }
  } catch {
    // Swallow — a failed analytics call must never surface to the visitor.
  }
}
