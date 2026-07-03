// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { capturePageview } from "@/lib/analytics/capturePageview";
import { proxy } from "./proxy";

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

  it("production, no session: mints an anonymous account", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const client = fakeClient({ user: null });
    mockedCreateServerClient.mockReturnValue(client as never);

    const res = await proxy(new NextRequest("https://nalu.ollie.gg/"));

    expect(client.auth.signInAnonymously).toHaveBeenCalledOnce();
    expect(res).toBeInstanceOf(NextResponse);
  });

  it("production, existing session: does not mint a new account", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const client = fakeClient({ user: { id: "user-1" } });
    mockedCreateServerClient.mockReturnValue(client as never);

    const res = await proxy(new NextRequest("https://nalu.ollie.gg/"));

    expect(client.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(res).toBeInstanceOf(NextResponse);
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

  it("production, minting: forwards Supabase cache-control headers onto the response", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const getUser = vi.fn().mockResolvedValue({ data: { user: null } });
    // Simulate @supabase/ssr writing a session: `signInAnonymously` invokes the
    // `setAll` cookie adapter with a cookie *and* the cache-control headers the
    // library always passes alongside auth cookies.
    const signInAnonymously = vi.fn().mockImplementation(async () => {
      const cookies = mockedCreateServerClient.mock.calls[0]?.[2]?.cookies;
      cookies?.setAll?.([{ name: "sb-access-token", value: "token", options: {} }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
      });
    });
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

  it("production, prefetch request: does not capture a pageview", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockedCreateServerClient.mockReturnValue(fakeClient({ user: { id: "user-1" } }) as never);

    await proxy(
      new NextRequest("https://nalu.ollie.gg/", { headers: { "next-router-prefetch": "1" } }),
      fakeEvent(),
    );

    expect(mockedCapture).not.toHaveBeenCalled();
  });
});
