import postgres from "postgres";
import { getEnv } from "@/lib/config";
import { isLocalDatabaseUrl } from "./isLocalDatabaseUrl";

/**
 * Wipes the local database for `just db-reset`, which then re-migrates and
 * re-seeds.
 *
 * Drops the `public` schema (every app table and enum) and the `drizzle`
 * schema (drizzle-kit's migration journal), then re-creates an empty
 * `public`. Other schemas, such as a local Supabase stack's `auth`, are left
 * alone. One transaction: a failure leaves the database as it was.
 *
 * Refuses unless `DIRECT_URL` points at this machine. `.env.local` may hold
 * the production Supabase URL (see `docs/DEPLOY.md`), and this is
 * destructive.
 */
async function main(): Promise<void> {
  const env = getEnv();
  if (!isLocalDatabaseUrl(env.DIRECT_URL)) {
    // Name the host only: the URL carries the password.
    const host = URL.canParse(env.DIRECT_URL) ? new URL(env.DIRECT_URL).hostname : "(unparseable)";
    throw new Error(
      `refusing to reset: DIRECT_URL host is ${host}, not this machine. ` +
        "Point DIRECT_URL at a local Postgres to reset it.",
    );
  }

  const client = postgres(env.DIRECT_URL, { max: 1 });
  // Without this finally block, a failed reset hangs on the open socket.
  try {
    await client.begin(async (tx) => {
      await tx`DROP SCHEMA IF EXISTS drizzle CASCADE`;
      await tx`DROP SCHEMA IF EXISTS public CASCADE`;
      await tx`CREATE SCHEMA public`;
    });
    console.warn("reset local database: dropped public and drizzle schemas");
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error("db reset failed", err);
  // CLI entrypoint must signal failure to the shell, so `just db-reset`
  // stops before it migrates or seeds.
  process.exitCode = 1;
});
