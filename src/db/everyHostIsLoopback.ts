/**
 * Hostnames that name this machine. No IPv6 `[::1]`: postgres-js reads that
 * host as `[`, so a reset could never connect to it.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/**
 * True when every host in a postgres-js client's parsed host list names this
 * machine. Guards destructive dev scripts: `.env.local` may hold the
 * production Supabase URL.
 *
 * Pass `client.options.host`, never a host parsed some other way. postgres-js
 * splits the userinfo at the first `@` and reads commas as a host list, so
 * WHATWG `URL` can see `localhost` where postgres-js dials production.
 */
export function everyHostIsLoopback(hosts: readonly string[]): boolean {
  return hosts.length > 0 && hosts.every((host) => LOOPBACK_HOSTS.has(host));
}
