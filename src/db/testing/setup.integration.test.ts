import { describe, it, expect } from "vitest";
import { getTestDbUrl } from "./setup";

describe("test container harness", () => {
  it("boots and exposes a Postgres URL", () => {
    // If this passes, beforeAll in setup.ts ran and container is up.
    // Postgres accepts both `postgres://` and `postgresql://` as URI schemes
    // (https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-URIS);
    // @testcontainers/postgresql emits the short form.
    expect(getTestDbUrl()).toMatch(/^postgres(ql)?:\/\//);
  });
});
