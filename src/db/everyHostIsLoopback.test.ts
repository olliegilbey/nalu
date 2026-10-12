import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { everyHostIsLoopback } from "./everyHostIsLoopback";

/**
 * The hosts postgres-js would dial for `url`: the same parse `reset.ts`
 * gates on. Building a client does no I/O until the first query.
 */
function hostsOf(url: string): readonly string[] {
  return postgres(url).options.host;
}

describe("everyHostIsLoopback", () => {
  it.each([
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgres://test:test@localhost:32768/test",
    "postgresql://postgres:postgres@localhost:5432,127.0.0.1:5433/postgres",
  ])("accepts loopback hosts: %s", (url) => {
    expect(everyHostIsLoopback(hostsOf(url))).toBe(true);
  });

  it.each([
    // The shape of a Supabase direct URL: the production database.
    "postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres",
    "postgresql://postgres.abcd:secret@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    // A loopback name buried in a remote host must not pass.
    "postgresql://postgres:postgres@localhost.example.com:5432/postgres",
    // IPv6 loopback: postgres-js cannot parse a bracketed host.
    "postgresql://postgres:postgres@[::1]:5432/postgres",
    // Crafted: WHATWG `URL` reads host `localhost`, but postgres-js splits
    // the userinfo at the first `@` and dials production first.
    "postgresql://u:x@db.prod.supabase.co,y@localhost:5432/postgres",
    "postgresql://u:x@db.prod.supabase.co%2Cy@localhost:5432/postgres",
    // One remote host in a list is enough to refuse.
    "postgresql://postgres:postgres@localhost:5432,db.prod.supabase.co:5432/postgres",
  ])("rejects a remote host: %s", (url) => {
    expect(everyHostIsLoopback(hostsOf(url))).toBe(false);
  });

  it("rejects an empty host list", () => {
    expect(everyHostIsLoopback([])).toBe(false);
  });
});
