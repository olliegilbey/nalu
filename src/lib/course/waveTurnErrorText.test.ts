import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { DrizzleQueryError } from "drizzle-orm";
import { NotFoundError } from "@/db/queries/errors";
import { waveTurnErrorText } from "./waveTurnErrorText";

describe("waveTurnErrorText", () => {
  it("passes a guard error's message through", () => {
    // The harness writes these; the learner can act on them.
    const guard = new TRPCError({ code: "PRECONDITION_FAILED", message: "no open questionnaire" });
    expect(waveTurnErrorText(guard)).toBe("no open questionnaire");
  });

  it("passes a not-found message through", () => {
    // The query layer writes these, and they quote ids only.
    const missing = new NotFoundError("course", "3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f");
    expect(waveTurnErrorText(missing)).toBe(
      "course not found: 3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f",
    );
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

    const text = waveTurnErrorText(failed);

    expect(text).not.toContain("correct");
    expect(text).not.toContain("Names move semantics.");
    expect(text).toBe(waveTurnErrorText(new Error("LLM transport failure")));
  });

  it("gives a thrown non-Error the same fixed text", () => {
    expect(waveTurnErrorText("boom")).toBe(waveTurnErrorText(new Error("other")));
  });
});
