import { isIPv4, isIPv6 } from "node:net";

/**
 * True when `host` names this machine. The one loopback rule for the DB
 * scripts: `localhost` in any case, with an optional trailing dot; any
 * 127.0.0.0/8 address; `0.0.0.0`; and IPv6 `::1` in any spelling, bracketed
 * or not. An empty host is not loopback, so every gate refuses it.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === "localhost" || name === "localhost." || name === "0.0.0.0") {
    return true;
  }
  if (isIPv4(name)) {
    return name.startsWith("127.");
  }
  const address = name.replace(/^\[(.*)\]$/, "$1");
  // WHATWG URL compresses every IPv6 spelling, so `0:0:0:0:0:0:0:1` reads `[::1]`.
  // `isIPv6` first: only a valid address reaches the parser.
  return isIPv6(address) && new URL(`http://[${address}]`).hostname === "[::1]";
}

/**
 * True when every host in a postgres-js client's parsed host list names this
 * machine. Gates the dev DB scripts (`reset.ts`, `assertLocalDirectUrl.ts`):
 * they refuse to touch any other database.
 *
 * Pass `client.options.host`, never a host parsed some other way. postgres-js
 * splits the userinfo at the first `@` and reads commas as a host list, so
 * WHATWG `URL` can see `localhost` where postgres-js dials production.
 * postgres-js reads bracketed IPv6 as `[`, so `[::1]` never passes here.
 */
export function everyHostIsLoopback(hosts: readonly string[]): boolean {
  return hosts.length > 0 && hosts.every(isLoopbackHost);
}

/**
 * True when the list is empty, or any host is empty or names this machine.
 * Gates `just db-migrate-prod` (`assertRemoteDirectUrl.ts`). That gate
 * refuses on a true, so feeding it more parses of the URL only adds refusals.
 */
export function someHostIsLoopbackOrEmpty(hosts: readonly string[]): boolean {
  return hosts.length === 0 || hosts.some((host) => host === "" || isLoopbackHost(host));
}
