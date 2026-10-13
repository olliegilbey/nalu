import { eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
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
import type { WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";
import { NotFoundError } from "./errors";
import { waveRowGuard } from "./waves";

/**
 * `waves` writes: open, close, and the `chat_log` append.
 *
 * All UPDATE statements use raw `db.execute(sql\`...\`)` (house style).
 * After each UPDATE, we re-fetch via Drizzle's typed select for camelCase
 * mapping — `RETURNING *` would give snake_case rows from the driver.
 */

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
   * Validated at write-time inside `openWave` (parse-before-persist) and again
   * on read via `waveRowGuard` — mirrors how `closeWave` handles `blueprintEmitted`.
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
  /**
   * Blueprint for the next Wave, emitted on the final turn. Nullable because
   * `blueprintEmittedSchema` is `blueprintSchema.nullable()` — a Wave can close
   * without emitting a blueprint (e.g. course-end Waves), and the JSONB column
   * is nullable in the schema.
   */
  readonly blueprintEmitted: Blueprint | null;
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
 *
 * Optional `tx` opts the INSERT into a caller's transaction so a Wave-open
 * rolls back atomically with sibling writes (e.g. scoping-close transaction).
 */
export async function openWave(params: OpenWaveParams, tx?: DbOrTx): Promise<Wave> {
  // Parse-before-persist boundary: each JSONB column is Zod-validated BEFORE
  // the insert so a malformed payload throws here rather than landing a bad
  // row that only fails on the next read via `waveRowGuard`. Mirrors the
  // pattern used in `closeWave` for `blueprintEmitted`.
  const validatedFramework = frameworkJsonbSchema.parse(params.frameworkSnapshot);
  const validatedDue = dueConceptsSnapshotSchema.parse(params.dueConceptsSnapshot);
  const validatedSeed = seedSourceSchema.parse(params.seedSource);

  const exec = tx ?? db;
  const [row] = await exec
    .insert(waves)
    .values({
      courseId: params.courseId,
      waveNumber: params.waveNumber,
      tier: params.tier,
      // Cast validated payloads → Drizzle JSONB column types.
      frameworkSnapshot: validatedFramework as Wave["frameworkSnapshot"],
      customInstructionsSnapshot: params.customInstructionsSnapshot,
      dueConceptsSnapshot: validatedDue as Wave["dueConceptsSnapshot"],
      seedSource: validatedSeed as Wave["seedSource"],
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
 * Idempotent: `COALESCE(closed_at, NOW())` means the timestamp never
 * re-stamps on a second call. `WHERE status = 'open'` scope prevents
 * accidentally re-writing a row that another path already closed.
 *
 * `blueprintEmitted` is Zod-validated before the write (parse-before-persist
 * boundary) so a malformed blueprint never reaches the DB.
 *
 * Optional `tx` opts the UPDATE and the re-fetch into a caller's transaction
 * so a Wave-close rolls back atomically with sibling writes (e.g. the close
 * transaction that closes Wave N + opens Wave N+1). Mirrors `openWave`'s
 * optional-tx pattern. Without tx-awareness, the close UPDATE would commit
 * via the `db` singleton even when a sibling tx aborts — breaking the
 * all-or-nothing close guarantee.
 *
 * BOTH the UPDATE and the re-fetch must run on the same executor — using the
 * `db` singleton for the re-fetch after a `tx` UPDATE would query a different
 * connection that cannot see the uncommitted change.
 *
 * @throws {NotFoundError} if `id` does not match any row (via the re-fetch).
 */
export async function closeWave(id: string, params: CloseWaveParams, tx?: DbOrTx): Promise<Wave> {
  // Validate JSONB BEFORE the write — never trust caller-supplied JSONB shape.
  const validatedBlueprint = blueprintEmittedSchema.parse(params.blueprintEmitted);

  // `::jsonb` cast ensures Postgres stores the value in the jsonb column type
  // even when the driver sends it as a string. COALESCE keeps closed_at
  // sticky across idempotent re-calls. Status scope prevents silent no-op on
  // already-closed waves (the re-fetch below still returns the existing row).
  // When the blueprint is null (e.g. course-end Waves), persist SQL NULL —
  // distinguishing "no blueprint emitted" from a JSON `null` value cleanly.
  const blueprintSql =
    validatedBlueprint === null ? sql`NULL` : sql`${JSON.stringify(validatedBlueprint)}::jsonb`;
  const exec = tx ?? db;
  await exec.execute(sql`
    UPDATE waves
    SET status = 'closed',
        summary = ${params.summary},
        blueprint_emitted = ${blueprintSql},
        closed_at = COALESCE(closed_at, NOW())
    WHERE id = ${id}
      AND status = 'open'
  `);

  // Re-fetch on the SAME executor. Inlined (rather than delegating to
  // `getWaveById`, which always uses the `db` singleton) so the row guard
  // observes the just-applied UPDATE inside the same tx.
  const [row] = await exec.select().from(waves).where(eq(waves.id, id));
  if (!row) throw new NotFoundError("wave", id);
  return waveRowGuard(row);
}

// ---------------------------------------------------------------------------
// chat_log append (typed JSONB store for the wave UI — mirrors scoping's
// per-stage JSONB columns on `courses`).
// ---------------------------------------------------------------------------

/**
 * Append one entry to `waves.chat_log`.
 *
 * Uses Postgres JSONB `||` concat so the write is atomic: no read-modify-write
 * round-trip, no lost-update race when two tx's append in parallel against the
 * same wave (they serialise on the row lock and apply in commit order).
 *
 * `tx` opts the UPDATE into a caller's transaction so the chat_log append
 * rolls back atomically with sibling writes (e.g. the persistWaveMidTurn tx that
 * grades answers and inserts assessment rows).
 */
export async function appendWaveChatLog(
  exec: DbOrTx,
  waveId: string,
  entry: WaveChatLogEntry,
): Promise<void> {
  // `::jsonb` cast guarantees Postgres treats the parameter as JSONB even
  // though the driver sends it as a JSON-encoded string. The array wrap is
  // required by `||` semantics (append-many).
  const payload = JSON.stringify([entry]);
  await exec.execute(sql`
    UPDATE waves
    SET chat_log = chat_log || ${payload}::jsonb
    WHERE id = ${waveId}
  `);
}
