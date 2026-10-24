import postgres from "postgres";
import { z } from "zod/v4";
import { someHostIsLoopbackOrEmpty } from "./everyHostIsLoopback";

/**
 * Gate for `just db-migrate-prod` and `just recompute-course-xp-prod`: exits 1
 * unless `DIRECT_URL` names only hosts other than this machine. Mirror of
 * `assertLocalDirectUrl.ts`.
 *
 * The recipes load `DIRECT_URL` from `.env.production.local`. Without this
 * gate, a missing file or a dev URL pasted into it would migrate or repair
 * the dev container while you believe you changed production.
 *
 * Reads `process.env` directly, not `getEnv()`: the recipe supplies only the
 * production values, so the full env schema need not hold here.
 */
async function main(): Promise<void> {
  const parsed = z.url().safeParse(process.env.DIRECT_URL);
  if (!parsed.success) {
    // Echo no value: a malformed URL can hold the password.
    throw new Error(
      "refusing: DIRECT_URL is missing or malformed. " +
        "Put the production DIRECT_URL in .env.production.local.",
    );
  }
  // drizzle-kit dials with `pg` when that package is installed, else with
  // postgres-js. Only `postgres` is installed, so postgres-js's parse is the
  // dialled one. Building the client does no I/O until the first query.
  // The WHATWG host is added because `pg` would dial it, and it keeps
  // bracketed IPv6 that postgres-js reads as `[`. Extra parses only add
  // refusals here, so they cannot let a dev URL through.
  const client = postgres(parsed.data, { max: 1 });
  try {
    const hosts = [...client.options.host, new URL(parsed.data).hostname];
    if (someHostIsLoopbackOrEmpty(hosts)) {
      throw new Error(
        "refusing: DIRECT_URL points at this machine, not production. " +
          "Put the production DIRECT_URL in .env.production.local.",
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error("production database gate refused", err);
  // CLI entrypoint must signal failure to the shell, so the recipe stops
  // before drizzle-kit or the repair runs.
  process.exitCode = 1;
});
