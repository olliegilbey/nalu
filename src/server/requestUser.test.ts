// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";
import { mintAnonymousLearner, readRequestSession } from "./requestUser";

// Supabase is mocked at `@supabase/ssr`, the seam `src/proxy.test.ts` uses.
// Next's request cookie store is faked so the test can see the session cookie
// the mint writes. The real `src/lib/supabase/server.ts` runs between them.
vi.mock("@/lib/config", () => ({
  getEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_stub",
  }),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));
// Read lazily inside `cookies()`, so it is initialised by the time it runs.
const cookieStore = { getAll: vi.fn(() => []), set: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));

const mockedCreateServerClient = vi.mocked(createServerClient);

/** The session cookie the fake Supabase client writes when it mints. */
const SESSION_COOKIE = { name: "sb-stub-auth-token", value: "session", options: { path: "/" } };

/**
 * A fake Supabase client. `getUser` resolves with `getUserResult`. A
 * successful `signInAnonymously` writes `SESSION_COOKIE` through the `setAll`
 * adapter, as @supabase/ssr does, and returns user `minted-1`.
 */
function fakeClient(getUserResult: unknown) {
  const getUser = vi.fn().mockResolvedValue(getUserResult);
  const signInAnonymously = vi.fn().mockImplementation(async () => {
    const adapter = mockedCreateServerClient.mock.calls[0]?.[2]?.cookies;
    await adapter?.setAll?.([SESSION_COOKIE], {});
    return { data: { user: { id: "minted-1" }, session: {} }, error: null };
  });
  const client = { auth: { getUser, signInAnonymously } };
  mockedCreateServerClient.mockReturnValue(client as never);
  return client;
}

/** A request to an API route; only the dev path reads its headers. */
function apiRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://nalu.ollie.gg/api/trpc/course.clarify", { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("mintAnonymousLearner", () => {
  it("non-production: never mints and never touches Supabase", async () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(await mintAnonymousLearner()).toBeUndefined();
    expect(mockedCreateServerClient).not.toHaveBeenCalled();
  });

  it("production: mints one anonymous learner and writes its cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const client = fakeClient({ data: { user: null }, error: new AuthSessionMissingError() });

    const userId = await mintAnonymousLearner();

    expect(userId).toBe("minted-1");
    expect(client.auth.signInAnonymously).toHaveBeenCalledOnce();
    // Next merges cookies set in a Route Handler into its response, so this
    // write is the `Set-Cookie` the browser receives.
    expect(cookieStore.set).toHaveBeenCalledWith(
      SESSION_COOKIE.name,
      SESSION_COOKIE.value,
      SESSION_COOKIE.options,
    );
  });

  it("production, revoked session: the read reports none, then the mint's cookie wins", async () => {
    // A revoked session's cookie still arrives. auth-js finds no live session
    // behind it, clears the cookie through `setAll`, and returns
    // AuthSessionMissingError. So a minting call mints, as the tRPC context
    // sequences it: read first, then mint.
    vi.stubEnv("NODE_ENV", "production");
    const client = fakeClient({ data: { user: null }, error: new AuthSessionMissingError() });
    client.auth.getUser.mockImplementationOnce(async () => {
      const adapter = mockedCreateServerClient.mock.calls[0]?.[2]?.cookies;
      await adapter?.setAll?.(
        [{ name: SESSION_COOKIE.name, value: "", options: { maxAge: 0 } }],
        {},
      );
      return { data: { user: null }, error: new AuthSessionMissingError() };
    });

    expect(await readRequestSession(apiRequest())).toEqual({ kind: "none" });
    const userId = await mintAnonymousLearner();

    expect(userId).toBe("minted-1");
    expect(client.auth.signInAnonymously).toHaveBeenCalledOnce();
    // The fresh session is the last write, so it is the cookie the browser keeps.
    expect(cookieStore.set).toHaveBeenCalledTimes(2);
    expect(cookieStore.set).toHaveBeenLastCalledWith(
      SESSION_COOKIE.name,
      SESSION_COOKIE.value,
      SESSION_COOKIE.options,
    );
  });

  it("production, mint fails: throws, so the failure is logged rather than a silent 401", async () => {
    // Supabase rate-limits anonymous sign-ins per IP. A disabled anonymous
    // provider fails the same way. Either must surface in the server log.
    vi.stubEnv("NODE_ENV", "production");
    const client = fakeClient({ data: { user: null }, error: new AuthSessionMissingError() });
    const limited = new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit");
    client.auth.signInAnonymously.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: limited,
    });

    await expect(mintAnonymousLearner()).rejects.toBe(limited);
  });
});

describe("readRequestSession", () => {
  it("non-production: reads the x-dev-user-id header and never touches Supabase", async () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(await readRequestSession(apiRequest({ "x-dev-user-id": "dev-1" }))).toEqual({
      kind: "learner",
      userId: "dev-1",
    });
    expect(await readRequestSession(apiRequest())).toEqual({ kind: "none" });
    expect(mockedCreateServerClient).not.toHaveBeenCalled();
  });

  it("production, no session: reports none and never mints (#246)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const client = fakeClient({ data: { user: null }, error: new AuthSessionMissingError() });

    expect(await readRequestSession(apiRequest())).toEqual({ kind: "none" });
    expect(client.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("production, existing session: reports its learner", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fakeClient({ data: { user: { id: "learner-1" } }, error: null });

    expect(await readRequestSession(apiRequest())).toEqual({
      kind: "learner",
      userId: "learner-1",
    });
  });

  it("production, session fails to load: reports failed, logs it, never mints", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const client = fakeClient({
      data: { user: null },
      error: new AuthRetryableFetchError("fetch failed", 0),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await readRequestSession(apiRequest())).toEqual({ kind: "failed" });
    expect(client.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      "[auth] session failed to load name=AuthRetryableFetchError\n",
    );
  });
});
