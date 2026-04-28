import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";
import { getTestDbUrl } from "./setup";

/**
 * Open a Drizzle client against the testcontainer and truncate every
 * table FIRST so each test starts on a known empty state.
 *
 * Tables listed leaf-first; CASCADE in the TRUNCATE handles FKs anyway,
 * but the explicit order keeps the intent obvious to a reader.
 */
const TABLES_LEAF_FIRST = [
  "assessments",
  "context_messages",
  "concepts",
  "waves",
  "scoping_passes",
  "courses",
  "user_profiles",
] as const;

/**
 * Wraps a test body with a fresh Drizzle client pointing at the testcontainer.
 *
 * Truncates all tables before invoking `fn` so every test starts from a
 * clean slate regardless of insertion order in prior tests.
 */
export async function withTestDb<T>(
  fn: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
): Promise<T> {
  const sql = postgres(getTestDbUrl(), { max: 1 });
  try {
    // Truncate leaf-first; CASCADE handles any FK ordering edge-cases.
    await sql.unsafe(`TRUNCATE ${TABLES_LEAF_FIRST.join(", ")} RESTART IDENTITY CASCADE`);
    const db = drizzle(sql, { schema });
    return await fn(db);
  } finally {
    await sql.end();
  }
}
