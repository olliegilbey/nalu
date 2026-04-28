import { describe, it, expect } from "vitest";
import { getTestDbUrl } from "./setup";

describe("test container harness", () => {
  it("boots and exposes a Postgres URL", () => {
    // If this passes, beforeAll in setup.ts ran and container is up.
    expect(getTestDbUrl()).toMatch(/^postgresql:\/\//);
  });
});
