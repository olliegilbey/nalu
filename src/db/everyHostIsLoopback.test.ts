import { describe, it, expect } from "vitest";
import postgres from "postgres";
import {
  everyHostIsLoopback,
  isLoopbackHost,
  someHostIsLoopbackOrEmpty,
} from "./everyHostIsLoopback";

/**
 * The hosts postgres-js would dial for `url`: the same parse `reset.ts`
 * gates on. Building a client does no I/O until the first query.
 */
function hostsOf(url: string): readonly string[] {
  return postgres(url).options.host;
}

describe("isLoopbackHost", () => {
  it.each([
    ["localhost", "localhost"],
    ["localhost in capitals", "LOCALHOST"],
    ["localhost in mixed case", "LocalHost"],
    ["localhost with a trailing dot", "localhost."],
    ["localhost in capitals with a trailing dot", "LOCALHOST."],
    ["127.0.0.1", "127.0.0.1"],
    ["another 127.0.0.0/8 address", "127.0.0.2"],
    ["the top of 127.0.0.0/8", "127.255.255.254"],
    ["the any-address", "0.0.0.0"],
    ["IPv6 ::1", "::1"],
    ["bracketed IPv6 ::1", "[::1]"],
    ["IPv6 ::1 written in full", "0:0:0:0:0:0:0:1"],
    ["bracketed IPv6 ::1 written in full", "[0:0:0:0:0:0:0:1]"],
  ])("accepts %s", (_form, host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    ["an empty host", ""],
    ["a Supabase host", "db.abcdefghijklmnop.supabase.co"],
    ["localhost as a subdomain", "localhost.example.com"],
    ["127.0.0.1 inside a DNS name", "127.0.0.1.nip.io"],
    ["an address just outside 127.0.0.0/8", "128.0.0.1"],
    ["a private address", "10.0.0.1"],
    ["IPv6 ::2", "::2"],
    ["the stub postgres-js leaves of a bracketed IPv6 host", "["],
    ["userinfo before localhost", "y@localhost"],
  ])("rejects %s", (_form, host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("everyHostIsLoopback", () => {
  it.each([
    "postgresql://postgres@127.0.0.1:54322/postgres",
    "postgres://test:test@localhost:32768/test",
    "postgresql://postgres@localhost:5432,127.0.0.1:5433/postgres",
    "postgresql://postgres@127.0.0.2:5432/postgres",
    "postgresql://postgres@0.0.0.0:5432/postgres",
    "postgresql://postgres@LOCALHOST:5432/postgres",
    "postgresql://postgres@localhost.:5432/postgres",
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
    // `localhost` outside the host part must not count: userinfo, path, query.
    // libpq honours `?host=`; postgres-js ignores it and dials the URL host.
    "postgresql://localhost@db.prod.supabase.co:5432/postgres",
    "postgresql://postgres:secret@db.prod.supabase.co:5432/localhost",
    "postgresql://postgres:secret@db.prod.supabase.co:5432/postgres?host=localhost",
  ])("rejects a remote host: %s", (url) => {
    expect(everyHostIsLoopback(hostsOf(url))).toBe(false);
  });

  it("rejects an empty host in a list", () => {
    // postgres-js parses `localhost,:5433` as ["localhost", ""].
    expect(everyHostIsLoopback(hostsOf("postgresql://postgres@localhost,:5433/postgres"))).toBe(
      false,
    );
  });

  it("rejects an empty host list", () => {
    expect(everyHostIsLoopback([])).toBe(false);
  });
});

describe("someHostIsLoopbackOrEmpty", () => {
  it.each([
    ["one loopback host", ["127.0.0.2"]],
    ["a loopback host after a remote one", ["db.prod.supabase.co", "localhost"]],
    ["an empty host after a remote one", ["db.prod.supabase.co", ""]],
    ["no host at all", []],
  ])("refuses %s", (_form, hosts) => {
    expect(someHostIsLoopbackOrEmpty(hosts)).toBe(true);
  });

  it("passes only remote hosts", () => {
    expect(someHostIsLoopbackOrEmpty(["db.prod.supabase.co", "aws-0.pooler.supabase.com"])).toBe(
      false,
    );
  });

  it("sees bracketed IPv6 ::1 through the WHATWG host that postgres-js mangles", () => {
    // postgres-js reads `[::1]` as `[`; `assertRemoteDirectUrl.ts` adds the
    // WHATWG host so the prod gate still refuses it.
    const url = "postgresql://postgres@[0:0:0:0:0:0:0:1]:5432/postgres";
    expect(someHostIsLoopbackOrEmpty(hostsOf(url))).toBe(false);
    expect(someHostIsLoopbackOrEmpty([...hostsOf(url), new URL(url).hostname])).toBe(true);
  });
});
