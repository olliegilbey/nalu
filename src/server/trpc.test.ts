import { describe, it, expect, vi, afterEach } from "vitest";
import { AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";

// Mock the Supabase server client. `getUserMock` is referenced lazily
// inside the factory, so it is initialised by the time the mock runs
// (mirrors the vi.mock pattern in src/lib/llm/generate.test.ts).
const getUserMock = vi.fn();
const signInAnonymouslyMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock, signInAnonymously: signInAnonymouslyMock },
  }),
}));

import { createTRPCContext } from "./trpc";

/** Minimal stand-in for tRPC's FetchCreateContextFnOptions — only `req` is read. */
function fakeOpts(headers: Record<string, string> = {}) {
  return {
    req: new Request("http://localhost/api/trpc", { headers }),
  } as unknown as Parameters<typeof createTRPCContext>[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
  getUserMock.mockReset();
  signInAnonymouslyMock.mockReset();
  // Restores the stderr spy even when an `expect` before it throws.
  vi.restoreAllMocks();
});

describe("createTRPCContext", () => {
  it("non-production: resolves userId from the x-dev-user-id header", async () => {
    const ctx = await createTRPCContext(fakeOpts({ "x-dev-user-id": "dev-1" }));
    expect(ctx.userId).toBe("dev-1");
  });

  it("production: resolves userId from the Supabase session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getUserMock.mockResolvedValueOnce({ data: { user: { id: "anon-uuid" } } });
    const ctx = await createTRPCContext(fakeOpts());
    expect(ctx.userId).toBe("anon-uuid");
  });

  it("production, no session: userId is undefined and nothing mints", async () => {
    // Only `mintingProcedure` mints, through `mintUserId` (#246).
    vi.stubEnv("NODE_ENV", "production");
    getUserMock.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    const ctx = await createTRPCContext(fakeOpts());
    expect(ctx.userId).toBeUndefined();
    expect(signInAnonymouslyMock).not.toHaveBeenCalled();
  });

  it("production: refuses the request as UNAUTHORIZED when the session fails to load", async () => {
    // The session is still a learner's: never answer them as a stranger,
    // never mint over them.
    vi.stubEnv("NODE_ENV", "production");
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: new AuthRetryableFetchError("fetch failed", 0),
    });
    // The resolver logs the failed load; keep it out of the test output.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(createTRPCContext(fakeOpts())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(signInAnonymouslyMock).not.toHaveBeenCalled();
  });
});
