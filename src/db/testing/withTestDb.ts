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
// TODO(B8): keep this in sync with schema/index.ts when the real barrel
// lands — adding a table without updating this list silently leaves stale
// rows between tests. Consider deriving from schema keys once B8 is done.
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
  // `typeof schema` is `{}` until B8 replaces the stub barrel, so the
  // inferred Drizzle generic is empty. The type will broaden automatically
  // once real table exports land — no changes needed here.
  fn: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
): Promise<T> {
  const sql = postgres(getTestDbUrl(), { max: 1 });
  try {
    // Truncate leaf-first; CASCADE handles any FK ordering edge-cases.
    // Table names are compile-time constants from `TABLES_LEAF_FIRST`, not
    // user input, so `sql.unsafe` is safe here.
    await sql.unsafe(`TRUNCATE ${TABLES_LEAF_FIRST.join(", ")} RESTART IDENTITY CASCADE`);
    const db = drizzle(sql, { schema });
    return await fn(db);
  } finally {
    await sql.end();
  }
}
