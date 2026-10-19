import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DrizzleSnapshotJSON, generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as schema from "./schema";

/*
 * Drift guard between the schema TS and the committed migrations (issue #207).
 * CI and production apply the committed SQL, never the schema. `drizzle-kit
 * check` checks only the migration history, so a schema edit without
 * `just db-generate` passed every gate. This test runs the diff `generate`
 * runs, in memory: it snapshots the schema and diffs it against the newest
 * committed snapshot. Any SQL in the diff is a missing migration.
 *
 * It also covers the SM-2 values `concepts.ts` reads from tuning.ts. A retune
 * changes the schema's SQL, so it shows up here as a missing migration.
 *
 * It lives outside `schema/`: drizzle-kit loads every file there, and a
 * Vitest import breaks `generate`.
 */

const META_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations/meta");

// The diff runs both ways. A schema edit with no migration prints the SQL to
// add it. A committed migration whose schema edit was reverted prints the SQL
// to undo it; generating that would undo the migration.
const FIX =
  "Schema and migrations disagree. If the SQL adds your schema edit, run " +
  "`just db-generate <name>` and commit it. If it undoes a committed " +
  "migration, restore the schema edit instead.";

/** The slice of drizzle-kit's `_journal.json` this test reads. */
const journalSchema = z.object({
  // A tag is `<prefix>_<name>`, e.g. `0011_easiness_factor_floor_real`.
  entries: z.array(z.object({ tag: z.string().regex(/^\d+_/) })),
});

/** Path of the newest committed snapshot, the one `generate` diffs against. */
function latestSnapshotPath(): string {
  const journal: unknown = JSON.parse(readFileSync(path.join(META_DIR, "_journal.json"), "utf8"));
  // Entry `<prefix>_<name>` owns `<prefix>_snapshot.json`. A hand-written
  // migration has an entry but no snapshot, like 0005, so skip those.
  const latest = journalSchema
    .parse(journal)
    .entries.map(({ tag }) =>
      path.join(META_DIR, `${tag.slice(0, tag.indexOf("_"))}_snapshot.json`),
    )
    .filter((file) => existsSync(file))
    .at(-1);
  if (!latest) throw new Error(`No drizzle-kit snapshot in ${META_DIR}`);
  return latest;
}

/** The newest committed snapshot, as drizzle-kit wrote it. */
function readLatestSnapshot(): DrizzleSnapshotJSON {
  const raw: unknown = JSON.parse(readFileSync(latestSnapshotPath(), "utf8"));
  // drizzle-kit keeps its snapshot Zod schema internal. `generateMigration`
  // parses its input with that schema first, so a malformed file still fails.
  return raw as DrizzleSnapshotJSON;
}

describe("schema vs the committed migrations", () => {
  it("needs no new migration", async () => {
    const committed = readLatestSnapshot();
    // The barrel exports every table, as drizzle-kit's folder load does.
    const current = generateDrizzleJson(schema);
    // A renamed table or column makes drizzle-kit ask "rename or recreate?".
    // A test has no TTY, so that throws "Interactive prompts require a TTY
    // terminal". Rethrow it with FIX, so the fix still prints.
    // `just db-generate` asks you the question instead.
    const sql = await generateMigration(committed, current).catch((error: unknown) => {
      throw new Error(`${FIX} drizzle-kit could not diff; a rename needs its prompt.`, {
        cause: error,
      });
    });
    expect(sql, FIX).toEqual([]);
  });
});
