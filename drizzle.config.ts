import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration.
 *
 * Schema TS files under src/db/schema/ are the source of truth; SQL is
 * generated into src/db/migrations/ and committed verbatim. Hand-edits to
 * generated migrations are forbidden by repo convention (see
 * src/db/CLAUDE.md). The one allowed bootstrap edit — prepending
 * `CREATE EXTENSION IF NOT EXISTS pgcrypto;` to 0000_init.sql — is
 * documented inline in that migration.
 *
 * Environment loading: justfile sets `dotenv-filename := ".env.local"`
 * so `just db-*` recipes auto-load .env.local (the dev database) before
 * invoking drizzle-kit. `just db-migrate-prod` swaps in the gitignored
 * .env.production.local. Run drizzle-kit only via `just db-*` recipes.
 */
export default defineConfig({
  schema: "./src/db/schema",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Migrations always go through the direct connection. Never the
    // PgBouncer pool — DDL on a transaction-mode pooler can deadlock.
    url: process.env.DIRECT_URL ?? "",
  },
  strict: true,
  verbose: true,
});
