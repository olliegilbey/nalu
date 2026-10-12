import { describe, it, expect } from "vitest";
import { isLocalDatabaseUrl } from "./isLocalDatabaseUrl";

describe("isLocalDatabaseUrl", () => {
  it.each([
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgres://test:test@localhost:32768/test",
    "postgresql://postgres:postgres@[::1]:5432/postgres",
  ])("accepts a loopback host: %s", (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(true);
  });

  it.each([
    // The shape of a Supabase direct URL: the production database.
    "postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres",
    "postgresql://postgres.abcd:secret@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    // A loopback name buried in a remote host must not pass.
    "postgresql://postgres:postgres@localhost.example.com:5432/postgres",
  ])("rejects a remote host: %s", (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(false);
  });

  it("rejects a string that is not a URL", () => {
    expect(isLocalDatabaseUrl("not a url")).toBe(false);
  });
});
