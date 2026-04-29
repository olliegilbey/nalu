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

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop: string | symbol) {
    return getDb()[prop as keyof ReturnType<typeof drizzle<typeof schema>>];
  },
});

export type DB = typeof db;
