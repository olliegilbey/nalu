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
 * Migrations run separately via `DIRECT_URL` (drizzle-kit), not this client.
 */
const env = getEnv();
const client = postgres(env.DATABASE_URL, { prepare: false });

export const db = drizzle(client, { schema });
export type DB = typeof db;
