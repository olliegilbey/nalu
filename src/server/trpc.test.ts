import { describe, it, expect, vi, afterEach } from "vitest";
import { AuthRetryableFetchError } from "@supabase/supabase-js";

// Mock the Supabase server client. `getUserMock` is referenced lazily
// inside the factory, so it is initialised by the time the mock runs
// (mirrors the vi.mock pattern in src/lib/llm/generate.test.ts).
const getUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: getUserMock } }),
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

  it("production: userId is undefined when the session fails to load", async () => {
    // A missing session mints instead; `src/server/requestUser.test.ts` owns
    // that rule. This case only checks the context passes `undefined` on.
    vi.stubEnv("NODE_ENV", "production");
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: new AuthRetryableFetchError("fetch failed", 0),
    });
    const ctx = await createTRPCContext(fakeOpts());
    expect(ctx.userId).toBeUndefined();
  });
});
