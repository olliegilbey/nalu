import { describe, it, expect } from "vitest";
import { buildPageviewEvent } from "./buildPageviewEvent";

const base = {
  apiKey: "phc_test",
  distinctId: "user-1",
  url: "https://nalu.ollie.gg/course/abc",
  referrer: null,
  userAgent: null,
  ip: null,
  timestamp: "2026-07-03T00:00:00.000Z",
};

describe("buildPageviewEvent", () => {
  it("builds a $pageview with the required top-level fields and app tag", () => {
    const e = buildPageviewEvent(base);
    expect(e.api_key).toBe("phc_test");
    expect(e.event).toBe("$pageview");
    expect(e.distinct_id).toBe("user-1");
    expect(e.timestamp).toBe("2026-07-03T00:00:00.000Z");
    expect(e.properties.$current_url).toBe("https://nalu.ollie.gg/course/abc");
    expect(e.properties.$pathname).toBe("/course/abc");
    expect(e.properties.app).toBe("nalu");
  });

  it("includes $ip only when an IP is provided (drives correct GeoIP)", () => {
    expect(buildPageviewEvent(base).properties.$ip).toBeUndefined();
    expect(buildPageviewEvent({ ...base, ip: "203.0.113.7" }).properties.$ip).toBe("203.0.113.7");
  });

  it("adds $referrer and $referring_domain from a valid referrer", () => {
    const e = buildPageviewEvent({ ...base, referrer: "https://www.linkedin.com/feed/" });
    expect(e.properties.$referrer).toBe("https://www.linkedin.com/feed/");
    expect(e.properties.$referring_domain).toBe("www.linkedin.com");
  });

  it("keeps $referrer but omits $referring_domain when the referrer is unparseable", () => {
    const e = buildPageviewEvent({ ...base, referrer: "not a url" });
    expect(e.properties.$referrer).toBe("not a url");
    expect(e.properties.$referring_domain).toBeUndefined();
  });

  it("passes the raw user agent for PostHog to derive browser/OS/device", () => {
    const e = buildPageviewEvent({ ...base, userAgent: "Mozilla/5.0 (X11)" });
    expect(e.properties.$raw_user_agent).toBe("Mozilla/5.0 (X11)");
  });

  it("extracts only utm_* params from the URL query, ignoring others", () => {
    const e = buildPageviewEvent({
      ...base,
      url: "https://nalu.ollie.gg/?utm_source=cv&utm_medium=email&ref=xyz",
    });
    expect(e.properties.utm_source).toBe("cv");
    expect(e.properties.utm_medium).toBe("email");
    expect(e.properties).not.toHaveProperty("ref");
    expect(e.properties).not.toHaveProperty("utm_campaign");
  });
});
