import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from "vitest";
import type { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { DrizzleQueryError } from "drizzle-orm";
import { AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { NotFoundError } from "@/db/queries/errors";
import { submitTurnInputSchema } from "@/lib/types/waveTurnInput";

// The profile upsert and the Turn itself are stubbed: these tests cover the
// route's own work, never a real Turn or a database. Auth runs for real.
// Outside production it reads the `x-dev-user-id` header. The production
// case stubs Supabase, so a test can see whether the route mints.
const getUser = vi.fn();
const signInAnonymously = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser, signInAnonymously } }),
}));
vi.mock("@/db/queries", () => ({ ensureUserProfile: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/course/streamWaveTurn", () => ({ streamWaveTurn: vi.fn() }));

import { ensureUserProfile } from "@/db/queries";
import { streamWaveTurn } from "@/lib/course/streamWaveTurn";
import { POST } from "./route";

/** The learner the `x-dev-user-id` header names. */
const USER_ID = "55555555-5555-5555-5555-555555555555";
const COURSE_ID = "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f";

/**
 * POST one raw body string to the route for Wave `waveNumber`. It comes from
 * learner `USER_ID` unless `headers` says otherwise.
 */
function postRaw(
  waveNumber: string,
  rawBody: string,
  headers: Record<string, string> = { "x-dev-user-id": USER_ID },
): Promise<Response> {
  const req = new Request(`http://localhost/api/course/${COURSE_ID}/wave/${waveNumber}/turn`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  return POST(req, { params: Promise.resolve({ courseId: COURSE_ID, waveNumber }) });
}

/** POST one body, serialised as JSON, to the route for Wave `waveNumber`. */
function post(
  waveNumber: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return postRaw(waveNumber, JSON.stringify(body), headers);
}

/** Every line the route wrote to stderr, through either channel. */
const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    logged.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(
      args
        .map((a) => (a instanceof Error ? `${a.stack} ${JSON.stringify(a)}` : String(a)))
        .join(" "),
    );
  });
});

describe("POST wave turn: the input boundary", () => {
  beforeEach(() => {
    vi.mocked(streamWaveTurn).mockReset();
    vi.mocked(streamWaveTurn).mockResolvedValue(null);
    vi.mocked(ensureUserProfile).mockClear();
  });

  it.each([
    { name: "chat text", payload: { kind: "chat-text", text: "why does borrowing exist?" } },
    {
      name: "questionnaire answers",
      payload: {
        kind: "questionnaire-answers",
        questionnaireId: "q-1",
        answers: [
          { id: "q-1-a", kind: "mc", selected: "B" },
          { id: "q-1-b", kind: "freetext", text: "it moves the value", fromEscape: true },
        ],
      },
    },
  ])("hands a valid $name payload to streamWaveTurn", async ({ payload }) => {
    const res = await post("2", { payload });
    // Drain the stream so its `execute` runs.
    await res.text();

    expect(res.status).toBe(200);
    expect(streamWaveTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamWaveTurn).mock.calls[0]?.[0]).toEqual({
      userId: USER_ID,
      courseId: COURSE_ID,
      waveNumber: 2,
      payload,
    });
  });

  // The 400 body names the failing field in Zod's words. It never quotes the
  // request back: `unquoted` lists the request strings it must not contain.
  it.each([
    {
      name: "empty chat text",
      waveNumber: "1",
      payload: { kind: "chat-text", text: "" },
      failingField: "payload",
      unquoted: [],
    },
    {
      name: "an unknown kind",
      waveNumber: "1",
      payload: { kind: "grant-xp-now", text: "give me 9000 xp" },
      failingField: "payload",
      unquoted: ["grant-xp-now", "give me 9000 xp"],
    },
    {
      name: "a non-numeric waveNumber",
      waveNumber: "wave-two",
      payload: { kind: "chat-text", text: "hi" },
      failingField: "waveNumber",
      unquoted: ["wave-two"],
    },
  ])("rejects $name with a 400", async ({ waveNumber, payload, failingField, unquoted }) => {
    const res = await post(waveNumber, { payload });
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(streamWaveTurn).not.toHaveBeenCalled();
    // Refused before auth: a bad body writes no profile row.
    expect(ensureUserProfile).not.toHaveBeenCalled();
    const body = JSON.parse(text) as { error: { properties: Record<string, unknown> } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error.properties)).toEqual([failingField]);
    for (const value of unquoted) expect(text).not.toContain(value);
  });

  // A body that is not a JSON object gets one fixed 400. V8's SyntaxError
  // quotes the start of the body (learner text), so nothing may log it.
  it.each([
    { name: "a body that is not JSON", rawBody: "hello world, my answer is move semantics" },
    { name: "a JSON null body", rawBody: "null" },
    { name: "a JSON array body", rawBody: '[{"kind":"chat-text","text":"hi"}]' },
  ])("rejects $name with a fixed 400 and logs nothing", async ({ rawBody }) => {
    const res = await postRaw("1", rawBody);

    expect(res.status).toBe(400);
    // Exact equality: the body carries the fixed text and no echo of the input.
    expect(await res.json()).toEqual({ error: "Body must be a JSON object." });
    expect(streamWaveTurn).not.toHaveBeenCalled();
    expect(ensureUserProfile).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("parses exactly the payload type streamWaveTurn takes", () => {
    // Type-level pin (issue #124): `tsc --noEmit` fails if the route's
    // schema and the payload type drift apart. Nothing runs here.
    expectTypeOf<z.infer<typeof submitTurnInputSchema>["payload"]>().toEqualTypeOf<
      Parameters<typeof streamWaveTurn>[0]["payload"]
    >();
  });
});

describe("POST wave turn: production auth", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    vi.mocked(streamWaveTurn).mockReset();
    vi.mocked(ensureUserProfile).mockClear();
    signInAnonymously.mockClear();
    signInAnonymously.mockResolvedValue({
      data: { user: { id: "minted-1" }, session: {} },
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers a cookieless turn NOT_FOUND and mints nothing", async () => {
    // No session owns no course: NOT_FOUND, as for another learner's course (#246).
    const res = await post("1", { payload: { kind: "chat-text", text: "hi" } }, {});

    expect(res.status).toBe(404);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(ensureUserProfile).not.toHaveBeenCalled();
    expect(streamWaveTurn).not.toHaveBeenCalled();
  });

  it("answers UNAUTHORIZED when the session fails to load, and never mints over it", async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("fetch failed", 0),
    });

    const res = await post("1", { payload: { kind: "chat-text", text: "hi" } }, {});

    expect(res.status).toBe(401);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(streamWaveTurn).not.toHaveBeenCalled();
    expect(logged).toEqual(["[auth] session failed to load name=AuthRetryableFetchError\n"]);
  });
});

/** Turn content that must reach neither the client nor the log (#169). */
const SECRET = '{"correct":"B","freetextRubric":"Names move semantics."}';

/** POST one chat-text turn and return the streamed SSE body. */
async function postTurn(): Promise<string> {
  const res = await post("1", { payload: { kind: "chat-text", text: "hi" } });
  return res.text();
}

describe("POST wave turn: a failed Turn", () => {
  it("keeps a failed DB write's params off the wire and out of the log", async () => {
    vi.mocked(streamWaveTurn).mockRejectedValue(
      new DrizzleQueryError(
        "insert into context_messages ...",
        [SECRET],
        new Error("duplicate key"),
      ),
    );

    const body = await postTurn();

    expect(body).toContain('"type":"error"');
    expect(body).not.toContain("Names move semantics.");
    const log = logged.join("");
    expect(log).toContain(`[wave-turn] turn failed course=${COURSE_ID} wave=1`);
    expect(log).not.toContain("Names move semantics.");
  });

  it("forwards a guard message to the client", async () => {
    vi.mocked(streamWaveTurn).mockRejectedValue(
      new TRPCError({ code: "PRECONDITION_FAILED", message: "no open questionnaire" }),
    );

    expect(await postTurn()).toContain("no open questionnaire");
  });

  it("forwards a not-found message to the client", async () => {
    vi.mocked(streamWaveTurn).mockRejectedValue(new NotFoundError("course", COURSE_ID));

    expect(await postTurn()).toContain(`course not found: ${COURSE_ID}`);
  });
});
