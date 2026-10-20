import postgres from "postgres";
import { z } from "zod/v4";
import { everyHostIsLoopback } from "./everyHostIsLoopback";

/**
 * Gate for `just db-migrate` and `just db-seed`: exits 1 unless every host
 * in `DIRECT_URL` is this machine. Mirror of `assertRemoteDirectUrl.ts`.
 *
 * `.env.local` holds dev values only, but an old `.env.local` or an exported
 * `DIRECT_URL` can still name production. This gate leaves
 * `just db-migrate-prod` as the only path to a remote database.
 *
 * Reads `process.env` directly, not `getEnv()`: migrating needs only the
 * database URL, not the LLM keys the full env schema requires.
 */
async function main(): Promise<void> {
  const parsed = z.url().safeParse(process.env.DIRECT_URL);
  if (!parsed.success) {
    // Echo no value: a malformed URL can hold the password.
    throw new Error(
      "refusing: DIRECT_URL is missing or malformed. " +
        "Point it at the dev database from `just db-up` (.env.local.example).",
    );
  }
  // drizzle-kit dials with `pg` when that package is installed, else with
  // postgres-js; seed.ts uses postgres-js. Only `postgres` is installed, so
  // postgres-js's parse is the dialled one. If `pg` is ever added, this gate
  // must check `pg`'s parse too. Building the client does no I/O.
  const client = postgres(parsed.data, { max: 1 });
  try {
    if (!everyHostIsLoopback(client.options.host)) {
      // Name no host: a malformed URL can leak part of the password into it.
      throw new Error(
        "refusing: DIRECT_URL must point only at this machine. " +
          "Production migrations run through `just db-migrate-prod`.",
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error("dev database gate refused", err);
  // CLI entrypoint must signal failure to the shell, so the recipe stops
  // before it migrates or seeds.
  process.exitCode = 1;
});
