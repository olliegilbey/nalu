import { asc, eq, and, sql, max } from "drizzle-orm";
import { db } from "@/db/client";
import { waves, type Wave } from "@/db/schema";
import {
  frameworkJsonbSchema,
  dueConceptsSnapshotSchema,
  seedSourceSchema,
  blueprintEmittedSchema,
  type DueConceptsSnapshot,
  type SeedSource,
  type Blueprint,
} from "@/lib/types/jsonb";
import { NotFoundError } from "./errors";

/**
 * `waves` query surface (spec §3.4).
 *
 * JSONB columns (`frameworkSnapshot`, `dueConceptsSnapshot`, `seedSource`,
 * `blueprintEmitted`) are validated via Zod on every read so consumers
 * receive typed, safe payloads.
 *
 * All UPDATE statements use raw `db.execute(sql\`...\`)` because
 * `db.update().set()` crashes `eslint-plugin-functional/immutable-data`.
 * After each UPDATE, we re-fetch via Drizzle's typed select for camelCase
 * mapping — `RETURNING *` would give snake_case rows from the driver.
 */

// Re-export so callers have one import site for the error class.
export { NotFoundError } from "./errors";

// ---------------------------------------------------------------------------
// Internal guard
// ---------------------------------------------------------------------------

/**
 * Validate JSONB columns on a raw `waves` row.
 *
 * Each non-null JSONB column is parsed through its schema; Zod strips unknown
 * keys and ensures structural correctness. `blueprintEmitted` is nullable —
 * we only parse it when it's populated (null is preserved as-is).
 */
export function waveRowGuard(row: Wave): Wave {
  return {
    ...row,
    // Trust-boundary validation: frameworkSnapshot is always present (NOT NULL).
    frameworkSnapshot: frameworkJsonbSchema.parse(row.frameworkSnapshot),
    // dueConceptsSnapshot is always present (NOT NULL).
    dueConceptsSnapshot: dueConceptsSnapshotSchema.parse(row.dueConceptsSnapshot),
    // seedSource is always present (NOT NULL).
    seedSource: seedSourceSchema.parse(row.seedSource),
    // blueprintEmitted is nullable — only validate when populated.
    blueprintEmitted: blueprintEmittedSchema.parse(row.blueprintEmitted),
  };
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Parameters required to open a new Wave row. */
export interface OpenWaveParams {
  /** FK to `courses.id` — the course this Wave belongs to. */
  readonly courseId: string;
  /** Ordinal within the course — 1-indexed, monotonically increasing. */
  readonly waveNumber: number;
  /** Learning tier this Wave targets. */
  readonly tier: number;
  /**
   * Snapshot of the course framework at Wave open time.
   * Frozen so mid-Wave edits to the course framework don't drift the prompt.
   * Caller is responsible for passing a valid FrameworkJsonb shape; waveRowGuard
   * validates on read (mirrors how courses.ts handles insert payloads).
   */
  readonly frameworkSnapshot: unknown;
  /** Optional custom instructions snapshot; null if none set. */
  readonly customInstructionsSnapshot: string | null;
  /** Due concepts injected at Wave start for spaced-repetition review. */
  readonly dueConceptsSnapshot: Readonly<DueConceptsSnapshot>;
  /** How this Wave was seeded — discriminated union. */
  readonly seedSource: SeedSource;
  /** Maximum turns for this Wave (enforced by the harness, not the model). */
  readonly turnBudget: number;
}

/** Parameters required to close an open Wave. */
export interface CloseWaveParams {
  /** LLM-generated summary of what was covered in this Wave. */
  readonly summary: string;
  /** Blueprint for the next Wave, emitted on the final turn. */
  readonly blueprintEmitted: Blueprint;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Fetch a wave by primary key.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function getWaveById(id: string): Promise<Wave> {
  const [row] = await db.select().from(waves).where(eq(waves.id, id));
  if (!row) throw new NotFoundError("wave", id);
  return waveRowGuard(row);
}

/**
 * Return the single open Wave for a course, or `null` if none exists.
 *
 * The partial unique index `waves_one_open_per_course` ensures at most one
 * open Wave per course at any time — so this query returns at most one row.
 */
export async function getOpenWaveByCourse(courseId: string): Promise<Wave | null> {
  const [row] = await db
    .select()
    .from(waves)
    .where(and(eq(waves.courseId, courseId), eq(waves.status, "open")));
  return row ? waveRowGuard(row) : null;
}

/**
 * List all closed Waves for a course, ordered by `waveNumber` ascending.
 *
 * Ordered asc so consumers can reconstruct the Wave sequence in presentation
 * order without re-sorting.
 */
export async function listClosedWavesByCourse(courseId: string): Promise<readonly Wave[]> {
  const rows = await db
    .select()
    .from(waves)
    .where(and(eq(waves.courseId, courseId), eq(waves.status, "closed")))
    .orderBy(asc(waves.waveNumber));
  return rows.map(waveRowGuard);
}

/**
 * Return the highest `waveNumber` for any Wave on a course.
 *
 * Returns `0` if no Waves exist yet — callers use this to determine the
 * ordinal of the next Wave to open (`getLatestWaveNumberByCourse(id) + 1`).
 */
export async function getLatestWaveNumberByCourse(courseId: string): Promise<number> {
  const [row] = await db
    .select({ maxWaveNumber: max(waves.waveNumber) })
    .from(waves)
    .where(eq(waves.courseId, courseId));
  // `max()` returns null when no rows match; treat as 0.
  return row?.maxWaveNumber ?? 0;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert a new Wave row with `status = 'open'` and return it.
 *
 * The partial unique index `waves_one_open_per_course` will throw a unique
 * violation if another open Wave already exists for this course — callers
 * must close the current Wave before opening the next.
 */
export async function openWave(params: OpenWaveParams): Promise<Wave> {
  const [row] = await db
    .insert(waves)
    .values({
      courseId: params.courseId,
      waveNumber: params.waveNumber,
      tier: params.tier,
      // Cast unknown → JSON string for Drizzle insert; DB stores as jsonb.
      frameworkSnapshot: params.frameworkSnapshot as Wave["frameworkSnapshot"],
      customInstructionsSnapshot: params.customInstructionsSnapshot,
      dueConceptsSnapshot: params.dueConceptsSnapshot as Wave["dueConceptsSnapshot"],
      seedSource: params.seedSource as Wave["seedSource"],
      turnBudget: params.turnBudget,
    })
    .returning();
  // The insert must return a row — no scenario where it doesn't on success.
  if (!row) throw new Error("openWave: insert returned no row");
  return waveRowGuard(row);
}

/**
 * Close an open Wave: sets `status = 'closed'`, records the summary and
 * blueprint, stamps `closed_at`.
 *
 * Uses raw SQL UPDATE to avoid `eslint-plugin-functional/immutable-data`
 * crash on `db.update().set()`. Re-fetches via `getWaveById` so the return
 * value goes through Drizzle's camelCase mapping and JSONB validation.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function closeWave(id: string, params: CloseWaveParams): Promise<Wave> {
  // Raw SQL UPDATE — mirrors the pattern from courses.ts and scopingPasses.ts.
  // `::jsonb` cast ensures Postgres stores the value in the jsonb column type
  // even when the driver sends it as a string.
  await db.execute(sql`
    UPDATE waves
    SET status = 'closed',
        summary = ${params.summary},
        blueprint_emitted = ${JSON.stringify(params.blueprintEmitted)}::jsonb,
        closed_at = NOW()
    WHERE id = ${id}
  `);

  // Re-fetch via typed Drizzle select for camelCase mapping and JSONB validation.
  // getWaveById throws NotFoundError if the row doesn't exist (id unknown or
  // DELETE raced the UPDATE — not realistic in tests but correct semantics).
  return getWaveById(id);
}
