import { describe, it, expect } from "vitest";
import { formatMutationError } from "./errors";

describe("formatMutationError", () => {
  it("includes HTTP status and code for a tRPC-shaped error", () => {
    const err = Object.assign(new Error("Rate limit exceeded"), {
      data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 },
    });
    expect(formatMutationError(err)).toBe("HTTP 429 · TOO_MANY_REQUESTS: Rate limit exceeded");
  });

  it("includes only the code when httpStatus is absent", () => {
    const err = Object.assign(new Error("Bad input"), {
      data: { code: "BAD_REQUEST" },
    });
    expect(formatMutationError(err)).toBe("BAD_REQUEST: Bad input");
  });

  it("falls back to the bare message when there is no data object", () => {
    expect(formatMutationError(new Error("Something broke"))).toBe("Something broke");
  });

  it("handles a plain string error", () => {
    expect(formatMutationError("plain string failure")).toBe("plain string failure");
  });

  it("handles a non-error, non-string input", () => {
    expect(formatMutationError(null)).toBe("Unknown error");
    expect(formatMutationError(undefined)).toBe("Unknown error");
  });
});
