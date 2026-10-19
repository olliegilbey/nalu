import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SM2 } from "@/lib/config/tuning";

/*
 * Drift guard for the SM-2 values the `concepts` schema reads from tuning.ts
 * (issue #197). The schema follows `SM2` at once; the database follows only
 * the committed migrations. A retune without `just db-generate` splits them,
 * and nothing else catches it: CI applies the committed SQL, and
 * `drizzle-kit check` checks only the migration history. So this test pins
 * the latest drizzle-kit snapshot to `SM2`.
 */

const META_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations/meta");

const FIX = "SM2 retuned without a migration? Run `just db-generate <name>`.";

/** The slice of a drizzle-kit snapshot this test reads. */
const conceptsSnapshotSchema = z.object({
  tables: z.object({
    "public.concepts": z.object({
      columns: z.object({ easiness_factor: z.object({ default: z.number() }) }),
      checkConstraints: z.object({
        concepts_easiness_factor_min: z.object({ value: z.string() }),
      }),
    }),
  }),
});

/** The `concepts` table in the newest snapshot, which `generate` diffs against. */
function readLatestConceptsSnapshot() {
  // Snapshot names carry a zero-padded index, so a text sort is a number sort.
  // This is the same pick drizzle-kit makes for its previous snapshot.
  // Journal order would fail on a hand-written entry with no snapshot, like
  // 0005.
  const latest = readdirSync(META_DIR)
    .filter((file) => file.endsWith("_snapshot.json"))
    .sort()
    .at(-1);
  if (!latest) throw new Error(`No drizzle-kit snapshot in ${META_DIR}`);
  const raw: unknown = JSON.parse(readFileSync(path.join(META_DIR, latest), "utf8"));
  return conceptsSnapshotSchema.parse(raw).tables["public.concepts"];
}

describe("concepts SM-2 values in the latest migration snapshot", () => {
  const concepts = readLatestConceptsSnapshot();

  it("easiness_factor defaults to SM2.initialEasinessFactor", () => {
    expect(concepts.columns.easiness_factor.default, FIX).toBe(SM2.initialEasinessFactor);
  });

  it("concepts_easiness_factor_min bounds at SM2.easinessFactorFloor", () => {
    expect(concepts.checkConstraints.concepts_easiness_factor_min.value, FIX).toBe(
      `"concepts"."easiness_factor" >= ${SM2.easinessFactorFloor}::real`,
    );
  });
});
