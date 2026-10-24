import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuthSessionMissingError } from "@supabase/supabase-js";

// A cookieless request in production: Supabase finds no session, and a mint
// returns learner `minted-1`. These tests cover only who gets minted (#246).
// They sit apart from `route.test.ts` because they stub Supabase and run as
// production; that file runs on the dev-stub header. The Turn, the state
// reads, the profile write and the profile upsert are stubbed. The custom
// instructions read stays real: it answers a caller with no session itself.
const getUser = vi.fn();
const signInAnonymously = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser, signInAnonymously } }),
}));
vi.mock("@/db/queries", () => ({ ensureUserProfile: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/course/clarify", () => ({ clarify: vi.fn() }));
vi.mock("@/lib/course/getState", () => ({ getState: vi.fn() }));
vi.mock("@/lib/course/getWaveState", () => ({ getWaveState: vi.fn() }));
vi.mock("@/lib/learner-profile/customInstructions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/learner-profile/customInstructions")>()),
  saveCustomInstructions: vi.fn(),
}));

import { clarify } from "@/lib/course/clarify";
import { getState } from "@/lib/course/getState";
import { getWaveState } from "@/lib/course/getWaveState";
import { saveCustomInstructions } from "@/lib/learner-profile/customInstructions";
import { GET, POST } from "./route";

const COURSE_ID = "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f";
const MINTED = "minted-1";

/** One call's result in a batch response body: data on success, an error shape on failure. */
type BatchEntry =
  | { readonly result: { readonly data: unknown } }
  | { readonly error: { readonly data: { readonly code: string } } };

/** Send a cookieless batched query the way httpBatchLink does. */
async function query(path: string, input: unknown): Promise<BatchEntry[]> {
  const params = new URLSearchParams({ batch: "1", input: JSON.stringify({ 0: input }) });
  const res = await GET(new Request(`http://localhost/api/trpc/${path}?${params}`));
  return (await res.json()) as BatchEntry[];
}

/** Send cookieless mutations as one batched POST, the way httpBatchLink folds same-tick calls. */
async function mutate(calls: readonly (readonly [string, unknown])[]): Promise<BatchEntry[]> {
  const paths = calls.map(([path]) => path).join(",");
  const body = Object.fromEntries(calls.map(([, input], i) => [i, input]));
  const res = await POST(
    new Request(`http://localhost/api/trpc/${paths}?batch=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as BatchEntry[];
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
  signInAnonymously.mockResolvedValue({
    data: { user: { id: MINTED }, session: {} },
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("a cookieless tRPC request", () => {
  it("course.getState answers NOT_FOUND and mints nothing", async () => {
    const [entry] = await query("course.getState", { courseId: COURSE_ID });

    expect(entry).toMatchObject({ error: { data: { code: "NOT_FOUND" } } });
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  it("wave.getState answers NOT_FOUND and mints nothing", async () => {
    const [entry] = await query("wave.getState", { courseId: COURSE_ID, waveNumber: 1 });

    expect(entry).toMatchObject({ error: { data: { code: "NOT_FOUND" } } });
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(getWaveState).not.toHaveBeenCalled();
  });

  it("profile.getCustomInstructions answers null and mints nothing", async () => {
    const [entry] = await query("profile.getCustomInstructions", undefined);

    expect(entry).toEqual({ result: { data: { customInstructions: null } } });
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it("course.clarify mints one learner and runs as them", async () => {
    vi.mocked(clarify).mockResolvedValue({} as Awaited<ReturnType<typeof clarify>>);

    const [entry] = await mutate([["course.clarify", { topic: "Rust ownership" }]]);

    expect(entry).toHaveProperty("result");
    expect(signInAnonymously).toHaveBeenCalledOnce();
    expect(clarify).toHaveBeenCalledWith({ userId: MINTED, topic: "Rust ownership" });
  });

  it("a batch of two minting calls shares one mint", async () => {
    vi.mocked(clarify).mockResolvedValue({} as Awaited<ReturnType<typeof clarify>>);
    vi.mocked(saveCustomInstructions).mockResolvedValue("Use analogies.");

    const entries = await mutate([
      ["course.clarify", { topic: "Rust ownership" }],
      ["profile.setCustomInstructions", { customInstructions: "Use analogies." }],
    ]);

    expect(entries.map((entry) => "result" in entry)).toEqual([true, true]);
    expect(signInAnonymously).toHaveBeenCalledOnce();
    expect(clarify).toHaveBeenCalledWith({ userId: MINTED, topic: "Rust ownership" });
    expect(saveCustomInstructions).toHaveBeenCalledWith(MINTED, "Use analogies.");
  });
});
