import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { DrizzleQueryError } from "drizzle-orm";
import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";
import { errorLogLine } from "./errorLogLine";

const IDS = { courseId: "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f", waveNumber: 2 } as const;

/** The line the Wave-turn route writes for a failed Turn. */
function waveLine(error: unknown): string {
  return errorLogLine(
    "[wave-turn] turn failed",
    { course: IDS.courseId, wave: IDS.waveNumber },
    error,
  );
}

/** Turn content that must never reach a production log line (#169). */
const SECRET = '{"correct":"B","freetextRubric":"Names move semantics."}';

/** A postgres-js PostgresError: the driver error Drizzle wraps as `cause`. */
function postgresError(): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint ${SECRET}`), {
    name: "PostgresError",
    code: "23505",
    constraint_name: "context_messages_wave_turn_seq_unique",
    detail: `Key (content)=(${SECRET}) already exists.`,
  });
}

describe("errorLogLine", () => {
  it("logs ids and Postgres codes for a failed DB write, never its params", () => {
    // Drizzle's message lists the query params: tool inputs, answer keys.
    const failed = new DrizzleQueryError(
      "insert into context_messages ...",
      [SECRET],
      postgresError(),
    );

    const line = waveLine(failed);

    expect(line).not.toContain("correct");
    expect(line).not.toContain("Names move semantics.");
    expect(line).toBe(
      `[wave-turn] turn failed course=${IDS.courseId} wave=2 name=Error inner=PostgresError` +
        " sqlstate=23505 constraint=context_messages_wave_turn_seq_unique",
    );
  });

  it("logs the HTTP status of a spent provider retry, never the response body", () => {
    const apiError = new APICallError({
      message: `Too Many Requests ${SECRET}`,
      url: "https://api.cerebras.ai/v1/chat/completions",
      requestBodyValues: { messages: SECRET },
      statusCode: 429,
      responseBody: SECRET,
    });
    const retry = new RetryError({
      message: `Failed after 7 attempts. Last error: ${apiError.message}`,
      reason: "maxRetriesExceeded",
      errors: [apiError],
    });

    const line = waveLine(retry);

    expect(line).not.toContain("Names move semantics.");
    expect(line).toContain("name=AI_RetryError inner=AI_APICallError");
    expect(line).toContain("status=429");
  });

  it("logs a guard error's TRPC code", () => {
    const guard = new TRPCError({ code: "PRECONDITION_FAILED", message: "no open questionnaire" });
    expect(waveLine(guard)).toContain("name=TRPCError trpcCode=PRECONDITION_FAILED");
  });

  it("drops a name that is not a plain token", () => {
    const odd = Object.assign(new Error("x"), { name: `bad name ${SECRET}` });
    expect(waveLine(odd)).toBe(`[wave-turn] turn failed course=${IDS.courseId} wave=2`);
  });

  it("drops a place value that is not a plain token", () => {
    // A tRPC path comes from the request URL, so the requester picks it.
    const place = { path: `course.clarify ${SECRET}`, batch: undefined };
    expect(errorLogLine("[trpc] procedure failed", place, new Error("x"))).toBe(
      "[trpc] procedure failed name=Error",
    );
  });
});
