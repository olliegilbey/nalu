import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/**
 * Test-only: poll until at least `count` backends in this database wait on a
 * lock. A race test holds one transaction open until the others are blocked
 * behind it, so the interleaving it asserts on really happens.
 *
 * Throws after ~5s (250 polls, 20ms apart) so a broken race fails loud.
 */
export async function waitForLockWaiters(count: number, attemptsLeft = 250): Promise<void> {
  const [row] = await db.execute<{ waiting: number }>(sql`
    SELECT count(*)::int AS waiting
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND wait_event_type = 'Lock'
  `);
  if ((row?.waiting ?? 0) >= count) return;
  if (attemptsLeft === 0) {
    throw new Error(`waitForLockWaiters: fewer than ${count} backends waited on a lock`);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return waitForLockWaiters(count, attemptsLeft - 1);
}
