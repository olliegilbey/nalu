import { buildPageviewEvent } from "./buildPageviewEvent";
import { getServerEnvironmentContext } from "./environmentContext";
import { sendPostHogEvent } from "./sendPostHogEvent";

/**
 * Server-side `$pageview` capture to PostHog EU. Called from `src/proxy.ts` via
 * `event.waitUntil`, so it runs after the response is sent and must never throw
 * — analytics failures cannot break page delivery.
 *
 * Sends direct to PostHog (not a reverse proxy) with the real client IP as
 * `$ip`, so PostHog Cloud's GeoIP resolves the visitor's location rather than
 * our server's. See the spec's Revision section.
 */

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
  // Pure build, then the shared send, which never throws.
  await sendPostHogEvent(
    buildPageviewEvent({
      apiKey: input.apiKey,
      distinctId: input.distinctId,
      url: input.url,
      referrer: input.headers.get("referer"),
      userAgent: input.headers.get("user-agent"),
      acceptLanguage: input.headers.get("accept-language"),
      ip: clientIp(input.headers),
      timestamp: input.timestamp,
      environment: getServerEnvironmentContext(),
    }),
  );
}
