/**
 * Hostnames that name this machine. No IPv6 `[::1]`: postgres-js reads that
 * host as `[`, so a reset could never connect to it.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/**
 * True when a Postgres URL points at this machine. Guards destructive dev
 * scripts: `.env.local` may hold the production Supabase URL.
 */
export function isLocalDatabaseUrl(url: string): boolean {
  // `URL.canParse` avoids a try/catch; a malformed URL is never local.
  return URL.canParse(url) && LOOPBACK_HOSTS.has(new URL(url).hostname);
}
