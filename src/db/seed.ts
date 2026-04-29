import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { userProfiles } from "./schema";
import { getEnv } from "@/lib/config";

/**
 * Idempotent dev-user seed.
 *
 * Inserts a `user_profiles` row at `DEV_USER_ID`. When auth wires up the
 * row also needs an `auth.users` entry — that's handled by `supabase db
 * reset` via SQL fixtures, out of scope for this milestone.
 *
 * Re-running is safe: `ON CONFLICT DO NOTHING` on the primary key means a
 * second invocation is a no-op (the existing row's `display_name` is NOT
 * overwritten, so manual edits in dev survive a re-seed).
 *
 * Uses `DIRECT_URL` (not `DATABASE_URL`) so the seed bypasses PgBouncer —
 * a one-shot script doesn't need pooling and direct is faster for cold
 * connections.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const client = postgres(env.DIRECT_URL, { max: 1 });
  const db = drizzle(client, { schema });

  await db
    .insert(userProfiles)
    .values({
      id: env.DEV_USER_ID,
      displayName: "Dev User",
    })
    .onConflictDoNothing({ target: userProfiles.id });

  await client.end();
  console.warn(`seeded dev user ${env.DEV_USER_ID}`);
}

main().catch((err: unknown) => {
  console.error("seed failed", err);
  // CLI entrypoint must signal failure to the shell; process.exitCode write
  // is the only standard way to do that.
  // eslint-disable-next-line functional/immutable-data
  process.exitCode = 1;
});
