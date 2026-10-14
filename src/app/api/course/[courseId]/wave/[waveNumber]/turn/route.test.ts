import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { DrizzleQueryError } from "drizzle-orm";
import { NotFoundError } from "@/db/queries/errors";

// Auth, the profile upsert and the Turn itself are stubbed: these tests
// cover only how the route reports a failed Turn.
vi.mock("@/server/requestUser", () => ({
  resolveRequestUserId: vi.fn().mockResolvedValue("55555555-5555-5555-5555-555555555555"),
}));
vi.mock("@/db/queries", () => ({ ensureUserProfile: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/course/streamWaveTurn", () => ({ streamWaveTurn: vi.fn() }));

import { streamWaveTurn } from "@/lib/course/streamWaveTurn";
import { POST } from "./route";

const COURSE_ID = "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f";

/** Turn content that must reach neither the client nor the log (#169). */
const SECRET = '{"correct":"B","freetextRubric":"Names move semantics."}';

/** Every line the route wrote to stderr, through either channel. */
const logged: string[] = [];

/** POST one chat-text turn and return the streamed SSE body. */
async function postTurn(): Promise<string> {
  const req = new Request(`http://localhost/api/course/${COURSE_ID}/wave/1/turn`, {
    method: "POST",
    body: JSON.stringify({ payload: { kind: "chat-text", text: "hi" } }),
  });
  const res = await POST(req, {
    params: Promise.resolve({ courseId: COURSE_ID, waveNumber: "1" }),
  });
  return res.text();
}

describe("POST wave turn: a failed Turn", () => {
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
