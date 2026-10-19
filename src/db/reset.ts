import postgres from "postgres";
import { getEnv } from "@/lib/config";
import { everyHostIsLoopback } from "./everyHostIsLoopback";

/**
 * Wipes the local database for `just db-reset`, which then re-migrates and
 * re-seeds.
 *
 * Drops the `public` schema (every app table and enum) and the `drizzle`
 * schema (drizzle-kit's migration journal), then re-creates an empty
 * `public`. Other schemas are left alone. One transaction: a failure leaves
 * the database as it was.
 *
 * Refuses unless every host in `DIRECT_URL` is this machine. This is
 * destructive, and an exported `DIRECT_URL` or a stale `.env.local` can still
 * name production (see `docs/DEPLOY.md`).
 */
async function main(): Promise<void> {
  const env = getEnv();
  // Build the client first: postgres-js does no I/O until the first query.
  // The gate then checks the hosts this client will dial, from one parser.
  const client = postgres(env.DIRECT_URL, { max: 1 });
  // Without this finally block, a failed reset hangs on the open socket.
  try {
    if (!everyHostIsLoopback(client.options.host)) {
      // Name no host: a malformed URL can leak part of the password into it.
      throw new Error(
        "refusing to reset: DIRECT_URL must point only at this machine. " +
          "Point DIRECT_URL at the dev database from `just db-up` to reset it.",
      );
    }
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
