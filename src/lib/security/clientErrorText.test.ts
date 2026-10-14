import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { DrizzleQueryError } from "drizzle-orm";
import { z } from "zod/v4";
import { NotFoundError } from "@/db/queries/errors";
import { clientErrorText } from "./clientErrorText";

describe("clientErrorText", () => {
  it("passes a guard error's message through", () => {
    // The harness writes these; the learner can act on them.
    const guard = new TRPCError({ code: "PRECONDITION_FAILED", message: "no open questionnaire" });
    expect(clientErrorText(guard)).toBe("no open questionnaire");
  });

  it("passes a not-found message through", () => {
    // The query layer writes these, and they quote ids only.
    const missing = new NotFoundError("course", "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f");
    expect(clientErrorText(missing)).toBe("course not found: 3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f");
  });

  it("keeps a failed DB write's params server-side", () => {
    // Drizzle's message lists the query params. Persisting a tool call
    // writes its input, so the params can hold the answer key (#169).
    const toolCallRow = JSON.stringify({
      calls: [{ input: { correct: "B", freetextRubric: "Names move semantics." } }],
    });
    const failed = new DrizzleQueryError(
      "insert into context_messages ...",
      [toolCallRow],
      new Error("duplicate key value violates unique constraint"),
    );

    const text = clientErrorText(failed);

    expect(text).not.toContain("correct");
    expect(text).not.toContain("Names move semantics.");
    expect(text).toBe(clientErrorText(new Error("LLM transport failure")));
  });

  it("gives a thrown non-Error the same fixed text", () => {
    expect(clientErrorText("boom")).toBe(clientErrorText(new Error("other")));
  });
});

describe("clientErrorText: errors as tRPC wraps them", () => {
  /** The fixed text every unsafe error gets. */
  const FIXED = clientErrorText(new Error("other"));

  it("keeps a failed DB write's params server-side once tRPC wraps it", () => {
    // tRPC wraps an unexpected throw without a message, so the wrapper
    // copies the cause's message: the params ride along (#171).
    const failed = new DrizzleQueryError(
      "insert into courses ...",
      ["Names move semantics."],
      new Error("duplicate key"),
    );
    const wrapped = new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: failed });

    expect(wrapped.message).toContain("Names move semantics.");
    expect(clientErrorText(wrapped)).toBe(FIXED);
  });

  it("passes a not-found message that mapNotFound rewrapped", () => {
    const missing = new NotFoundError("course", "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f");
    const rewrapped = new TRPCError({
      code: "NOT_FOUND",
      message: missing.message,
      cause: missing,
    });
    expect(clientErrorText(rewrapped)).toBe(missing.message);
  });

  it("passes a TRPCError's own message over its cause's", () => {
    const own = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Output validation failed",
      cause: new Error("Names move semantics."),
    });
    expect(clientErrorText(own)).toBe("Output validation failed");
  });

  it("passes tRPC's input-validation message: it describes the requester's own input", () => {
    const issues = z.object({ topic: z.string().min(1) }).safeParse({ topic: "" }).error;
    const invalid = new TRPCError({ code: "BAD_REQUEST", cause: issues });
    expect(clientErrorText(invalid)).toContain("Too small: expected string to have >=1 characters");
  });

  it("keeps a ZodError thrown inside a procedure server-side", () => {
    // A failed parse of an LLM reply or a DB row: tRPC wraps it as a 500.
    const issues = z.object({ correct: z.enum(["A", "B"]) }).safeParse({ correct: "E" }).error;
    const wrapped = new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: issues });
    expect(clientErrorText(wrapped)).toBe(FIXED);
  });
});
