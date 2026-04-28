import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";

/**
 * Single Postgres container per integration test run.
 *
 * Migrations apply once; each test resets state via `withTestDb` (truncate
 * all tables in FK-safe order). Serialised via `fileParallelism: false`
 * in vitest.integration.config.ts so we never spawn parallel containers.
 */
let container: StartedPostgreSqlContainer | undefined; // eslint-disable-line functional/no-let
let url: string | undefined; // eslint-disable-line functional/no-let

beforeAll(async () => {
  // postgres:16-alpine ships with postgresql-contrib so pgcrypto is available
  // without any extra setup — mirror prod where gen_random_uuid() relies on it.
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  // Use a local const so TS can narrow away `undefined` before we assign to
  // the module-level `url` variable.
  const startedUrl = container.getConnectionUri();
  url = startedUrl;
  // Mutate process.env so any module that reads the URL (config loader,
  // Drizzle client created inside withTestDb) sees the testcontainer
  // address. This is the one legitimate place we touch process.env.
  process.env.DATABASE_URL = url; // eslint-disable-line functional/immutable-data
  process.env.DIRECT_URL = url; // eslint-disable-line functional/immutable-data

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  await sql.end();
});

afterAll(async () => {
  await container?.stop();
});

/**
 * Returns the connection URI for the testcontainer Postgres instance.
 *
 * Throws if called before `beforeAll` has completed (i.e. setupFiles ran
 * out of order or outside the integration vitest project).
 */
export function getTestDbUrl(): string {
  if (!url) throw new Error("Test DB not started — setupFiles ran out of order");
  return url;
}
