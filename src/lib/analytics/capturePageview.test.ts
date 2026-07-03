import { describe, it, expect, vi, afterEach } from "vitest";
import { capturePageview } from "./capturePageview";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function run(headers: Record<string, string>) {
  return capturePageview({
    apiKey: "phc_test",
    distinctId: "user-1",
    url: "https://nalu.ollie.gg/?utm_source=cv",
    headers: new Headers(headers),
    timestamp: "2026-07-03T00:00:00.000Z",
  });
}

describe("capturePageview", () => {
  it("POSTs the built $pageview to PostHog EU, taking the first x-forwarded-for IP as $ip", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"Ok"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await run({
      "x-forwarded-for": "203.0.113.7, 70.41.3.18",
      referer: "https://www.linkedin.com/",
      "user-agent": "Mozilla/5.0",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      event: string;
      distinct_id: string;
      properties: Record<string, string | boolean | undefined>;
    };
    expect(body.event).toBe("$pageview");
    expect(body.properties.source).toBe("preview");
    expect(body.distinct_id).toBe("user-1");
    expect(body.properties.$ip).toBe("203.0.113.7");
    expect(body.properties.$referrer).toBe("https://www.linkedin.com/");
    expect(body.properties.$raw_user_agent).toBe("Mozilla/5.0");
    expect(body.properties.utm_source).toBe("cv");
    // The waitUntil task must be time-bounded — a hung request would keep the
    // invocation alive with no benefit.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("logs non-2xx capture responses (fetch does not reject on HTTP errors)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(run({})).resolves.toBeUndefined();

    // Without this signal a bad key or PostHog outage kills analytics silently.
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("never throws when the network call fails (analytics must not break page delivery)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(run({})).resolves.toBeUndefined();
  });
});
