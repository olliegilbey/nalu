import { describe, it, expect } from "vitest";
import { createQueryClient } from "./queryClient";

const notFound = Object.assign(new Error("course not found"), {
  data: { code: "NOT_FOUND", httpStatus: 404 },
});
const serverError = Object.assign(new Error("boom"), {
  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
});

/** The client's default query retry rule, narrowed to its function form. */
function defaultRetry() {
  const retry = createQueryClient().getDefaultOptions().queries?.retry;
  if (typeof retry !== "function") throw new Error("expected a retry function");
  return retry;
}

describe("createQueryClient retry", () => {
  it("never retries a NOT_FOUND query", () => {
    expect(defaultRetry()(0, notFound)).toBe(false);
  });

  it("retries any other failure three times", () => {
    const retry = defaultRetry();
    expect([0, 1, 2, 3].map((failureCount) => retry(failureCount, serverError))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
