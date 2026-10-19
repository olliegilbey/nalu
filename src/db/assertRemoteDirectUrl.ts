import postgres from "postgres";
import { z } from "zod/v4";
import { everyHostIsLoopback } from "./everyHostIsLoopback";

/**
 * Gate for `just db-migrate-prod`: exits 1 unless `DIRECT_URL` names a host
 * other than this machine.
 *
 * The recipe loads `DIRECT_URL` from `.env.production.local`. Without this
 * gate, a missing file or a dev URL pasted into it would migrate the dev
 * container while you believe you migrated production.
 *
 * Reads `process.env` directly, not `getEnv()`: the recipe supplies only the
 * database URLs, so the full env schema need not hold here.
 */
async function main(): Promise<void> {
  const parsed = z.url().safeParse(process.env.DIRECT_URL);
  if (!parsed.success) {
    // Echo no value: a malformed URL can hold the password.
    throw new Error(
      "refusing to migrate: DIRECT_URL is missing or malformed. " +
        "Put the production DIRECT_URL in .env.production.local.",
    );
  }
  // Build the client first: postgres-js does no I/O until the first query.
  // The gate then checks the hosts drizzle-kit's postgres-js driver will dial.
  const client = postgres(parsed.data, { max: 1 });
  try {
    if (everyHostIsLoopback(client.options.host)) {
      throw new Error(
        "refusing to migrate: DIRECT_URL points at this machine, not production. " +
          "Put the production DIRECT_URL in .env.production.local.",
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error("db-migrate-prod refused", err);
  // CLI entrypoint must signal failure to the shell, so the recipe stops
  // before drizzle-kit runs.
  process.exitCode = 1;
});
