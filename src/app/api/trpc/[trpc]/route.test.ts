import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { DrizzleQueryError } from "drizzle-orm";
import { NotFoundError } from "@/db/queries/errors";

// The profile upsert and the scoping Turn are stubbed: these tests cover
// only what a failed procedure sends to the client and to the log.
vi.mock("@/db/queries", () => ({ ensureUserProfile: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/course/clarify", () => ({ clarify: vi.fn() }));

import { clarify } from "@/lib/course/clarify";
import { POST } from "./route";

const COURSE_ID = "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f";

/** Scoping content that must reach neither the client nor the log (issue #171). */
const SECRET = '{"correct":"B","freetextRubric":"Names move semantics."}';

/** Every line the handler wrote to stderr, through either channel. */
const logged: string[] = [];

/** A failed DB write: Drizzle's message lists the params, the driver error sits in `cause`. */
function failedWrite(): DrizzleQueryError {
  const driverError = Object.assign(new Error(`duplicate key ${SECRET}`), {
    name: "PostgresError",
    code: "23505",
    constraint_name: "courses_pkey",
  });
  return new DrizzleQueryError("insert into courses ...", [SECRET], driverError);
}

/** POST `course.clarify` the way the client's httpBatchLink does; return the raw body. */
async function postClarify(topic: string): Promise<string> {
  const req = new Request("http://localhost/api/trpc/course.clarify?batch=1", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dev-user-id": "dev-user" },
    body: JSON.stringify({ 0: { topic } }),
  });
  const res = await POST(req);
  return res.text();
}

/** The first call's error shape from a batch response body. */
function errorShape(body: string): { message: string; data: Record<string, unknown> } {
  return (JSON.parse(body) as [{ error: { message: string; data: Record<string, unknown> } }])[0]
    .error;
}

describe("POST /api/trpc: a failed procedure", () => {
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

  it("keeps a failed DB write's params off the wire", async () => {
    vi.mocked(clarify).mockRejectedValue(failedWrite());

    const body = await postClarify("Rust ownership");

    expect(body).not.toContain("Names move semantics.");
    expect(body).not.toContain("insert into courses");
    const shape = errorShape(body);
    expect(shape.message).toBe("Something went wrong. Please try again.");
    expect(shape.data).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      httpStatus: 500,
      path: "course.clarify",
    });
  });

  it("logs one content-free line for the failed DB write", async () => {
    vi.mocked(clarify).mockRejectedValue(failedWrite());

    await postClarify("Rust ownership");

    const log = logged.join("");
    expect(log).toBe(
      "[trpc] procedure failed path=course.clarify name=Error inner=PostgresError" +
        " sqlstate=23505 constraint=courses_pkey\n",
    );
  });

  it("forwards a guard message to the client, unlogged", async () => {
    vi.mocked(clarify).mockRejectedValue(
      new TRPCError({ code: "PRECONDITION_FAILED", message: "no open questionnaire" }),
    );

    const shape = errorShape(await postClarify("Rust ownership"));

    expect(shape.message).toBe("no open questionnaire");
    expect(shape.data.code).toBe("PRECONDITION_FAILED");
    expect(logged).toEqual([]);
  });

  it("forwards a not-found message as NOT_FOUND", async () => {
    vi.mocked(clarify).mockRejectedValue(new NotFoundError("course", COURSE_ID));

    const shape = errorShape(await postClarify("Rust ownership"));

    expect(shape.message).toBe(`course not found: ${COURSE_ID}`);
    expect(shape.data.code).toBe("NOT_FOUND");
  });

  it("forwards an input-validation message: it describes the learner's own input", async () => {
    const shape = errorShape(await postClarify(""));

    expect(shape.data.code).toBe("BAD_REQUEST");
    expect(shape.message).toContain("Too small: expected string to have >=1 characters");
    expect(vi.mocked(clarify)).not.toHaveBeenCalledWith(expect.objectContaining({ topic: "" }));
  });
});
