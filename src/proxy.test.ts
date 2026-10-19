// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { capturePageview } from "@/lib/analytics/capturePageview";
import { proxy, config } from "./proxy";

// The proxy reads the env schema and constructs a Supabase SSR client. Both are
// stubbed so the production branches can be exercised without real env vars or
// a live auth server — `vi.mock` is hoisted above the imports above.
vi.mock("@/lib/config", () => ({
  getEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_stub",
    POSTHOG_KEY: "phc_test",
  }),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));
vi.mock("@/lib/analytics/capturePageview", () => ({ capturePageview: vi.fn() }));

const mockedCreateServerClient = vi.mocked(createServerClient);
const mockedCapture = vi.mocked(capturePageview);

/** Minimal `NextFetchEvent` stub exposing a spyable `waitUntil`. */
function fakeEvent(): NextFetchEvent {
  return { waitUntil: vi.fn() } as unknown as NextFetchEvent;
}

/**
 * Builds a fake Supabase client. `user` is what `getUser()` resolves with;
 * `getUserError` makes `getUser()` reject to drive the fail-open path.
 */
function fakeClient(opts: { user: unknown; getUserError?: boolean }) {
  const getUser = opts.getUserError
    ? vi.fn().mockRejectedValue(new Error("auth host unreachable"))
    : vi.fn().mockResolvedValue({ data: { user: opts.user } });
  const signInAnonymously = vi.fn().mockResolvedValue({ data: {}, error: null });
  return { auth: { getUser, signInAnonymously } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("proxy", () => {
  it("non-production: passes through without touching Supabase", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await proxy(new NextRequest("http://localhost/"));
    expect(res).toBeInstanceOf(NextResponse);
    expect(mockedCreateServerClient).not.toHaveBeenCalled();
  });

  it("production, no session: mints nothing and sets no cookie (#232)", async () => {
    // Crawlers, link unfurlers and uptime checks arrive with no cookie. A page
    // load must not create an `auth.users` row for them; the first API request
    // that needs a learner mints instead (`src/server/requestUser.ts`).
    vi.stubEnv("NODE_ENV", "production");
    const client = fakeClient({ user: null });
    mockedCreateServerClient.mockReturnValue(client as never);

    const res = await proxy(new NextRequest("https://nalu.ollie.gg/"));

    expect(client.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("production, auth failure: fails open and logs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockedCreateServerClient.mockReturnValue(
      fakeClient({ user: null, getUserError: true }) as never,
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await proxy(new NextRequest("https://nalu.ollie.gg/"));

    expect(res).toBeInstanceOf(NextResponse);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("production, refreshing: forwards Supabase cache-control headers onto the response", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Simulate @supabase/ssr refreshing an expired session: `getUser` invokes
    // the `setAll` cookie adapter with a cookie *and* the cache-control headers
    // the library always passes alongside auth cookies. The library awaits
    // `setAll` (its type allows a Promise), so the stub awaits it too.
    const getUser = vi.fn().mockImplementation(async () => {
      const cookies = mockedCreateServerClient.mock.calls[0]?.[2]?.cookies;
      await cookies?.setAll?.([{ name: "sb-access-token", value: "token", options: {} }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
      });
      return { data: { user: { id: "user-1" } } };
    });
    const signInAnonymously = vi.fn();
    mockedCreateServerClient.mockReturnValue({ auth: { getUser, signInAnonymously } } as never);

    const res = await proxy(new NextRequest("https://nalu.ollie.gg/"));

    // The header must reach the response, or a CDN could cache the
    // `Set-Cookie` and replay one visitor's session token to another.
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });

  it("production, key + user + real navigation: fires a pageview via waitUntil", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockedCreateServerClient.mockReturnValue(fakeClient({ user: { id: "user-1" } }) as never);
    const event = fakeEvent();

    await proxy(new NextRequest("https://nalu.ollie.gg/?utm_source=cv"), event);

    expect(event.waitUntil).toHaveBeenCalledOnce();
    expect(mockedCapture).toHaveBeenCalledOnce();
    expect(mockedCapture.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "phc_test",
      distinctId: "user-1",
      url: "https://nalu.ollie.gg/?utm_source=cv",
    });
  });

  it("production, no session: still fires the landing pageview, under a throwaway id", async () => {
    // The landing pageview carries the referrer and UTM tags. Losing it with
    // the mint would blind visitor forensics to everyone who lands and leaves.
    vi.stubEnv("NODE_ENV", "production");
    mockedCreateServerClient.mockReturnValue(fakeClient({ user: null }) as never);
    const event = fakeEvent();

    await proxy(new NextRequest("https://nalu.ollie.gg/?utm_source=cv"), event);
    await proxy(new NextRequest("https://nalu.ollie.gg/?utm_source=cv"), event);

    expect(mockedCapture).toHaveBeenCalledTimes(2);
    const [first, second] = mockedCapture.mock.calls.map(([input]) => input.distinctId);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Fresh per request: no stable id ties two cookieless hits together.
    expect(second).not.toBe(first);
  });

  it("matcher: skips prefetches via `missing` conditions (runtime checks can't — Next strips the headers)", () => {
    // Guards against flattening the matcher back to a bare string: prefetch
    // filtering only works at the matcher level, so losing the `missing`
    // conditions would silently reintroduce phantom pageviews on
    // hover-prefetches.
    expect(config.matcher).toEqual([
      {
        // Dotted-path exclusion covers all static assets (no app route has a
        // `.`); losing it would count asset fetches as pageviews.
        source: "/((?!api|_next/static|_next/image|.*\\..*).*)",
        missing: [
          { type: "header", key: "next-router-prefetch" },
          { type: "header", key: "purpose", value: "prefetch" },
        ],
      },
    ]);
  });
});
