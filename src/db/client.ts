import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { getEnv } from "@/lib/config";

/**
 * Drizzle client singleton. Connects via the pooled `DATABASE_URL`
 * (PgBouncer in transaction mode), so `prepare: false` is required —
 * prepared statements don't survive the pool's per-transaction
 * connection binding.
 *
 * Lazy init: the client is created on first access rather than at module
 * load time. This lets integration tests set `process.env.DATABASE_URL`
 * in `beforeAll` before the client is constructed — static module
 * evaluation happens before `setupFiles`/`beforeAll` hooks run.
 *
 * Migrations run separately via `DIRECT_URL` (drizzle-kit), not this client.
 */

// Mutable cache — intentional; lazy singleton pattern.
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined; // eslint-disable-line functional/no-let

/** Returns the lazily-initialised Drizzle client. */
function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    const env = getEnv();
    const client = postgres(env.DATABASE_URL, { prepare: false });
    _db = drizzle(client, { schema });
  }
  return _db;
}

/**
 * Singleton Drizzle client for the application. Connects via the pooled
 * `DATABASE_URL` (PgBouncer in transaction mode). The underlying postgres-js
 * connection is created lazily on first access; to close it call
 * `(db as unknown as { $client: { end(): Promise<void> } }).$client.end()`.
 * Callers must NOT create their own postgres-js pool — a second pool against
 * the same PgBouncer URL wastes connections and breaks prepared-statement
 * semantics. For migration use cases, `DIRECT_URL` is wired in `drizzle.config.ts`.
 */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop: string | symbol) {
    const inner = getDb();
    const value = inner[prop as keyof typeof inner];
    // Bind so Drizzle's internal `this`-access points at the real client,
    // not the proxy (avoids repeated getDb() trips and matches non-lazy semantics).
    return typeof value === "function"
      ? (value as (...a: unknown[]) => unknown).bind(inner)
      : value;
  },
});

export type DB = typeof db;
