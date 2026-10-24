import { eq, and, count } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { waves, type Wave } from "@/db/schema";
import {
  frameworkJsonbSchema,
  dueConceptsSnapshotSchema,
  seedSourceSchema,
  blueprintEmittedSchema,
} from "@/lib/types/jsonb";
import { waveChatLogSchema, type WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";
import { NotFoundError } from "./errors";

/**
 * `waves` query surface (spec §3.4): row guard and reads.
 *
 * JSONB columns (`frameworkSnapshot`, `dueConceptsSnapshot`, `seedSource`,
 * `blueprintEmitted`) are validated via Zod on every read so consumers
 * receive typed, safe payloads.
 *
 * Writes (open, close, chat_log append) live in `waves.writes.ts`.
 */

/** Re-exported domain error for missing query targets — single import site for callers. */
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
    // chat_log is NOT NULL with a default of [], so it's always populated.
    // Validation here mirrors the trust-boundary discipline of courseRowGuard.
    // Cast needed because Drizzle types unparameterised JSONB as `unknown`.
    chatLog: waveChatLogSchema.parse(row.chatLog) as Wave["chatLog"],
  };
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
 * Fetch the Wave for `(courseId, waveNumber)` — the natural addressing scheme
 * the client uses (URLs carry the ordinal, not the row id). The unique index
 * `waves_course_wave_number_unique` guarantees at most one match.
 *
 * Returns `null` when no row exists; callers (e.g. `prepareWaveTurn`,
 * `getWaveState`) translate that into a TRPC error with the appropriate code.
 * Returning `null` rather than throwing keeps the query layer's NotFoundError
 * convention reserved for primary-key lookups.
 */
export async function getWaveByCourseAndNumber(
  courseId: string,
  waveNumber: number,
): Promise<Wave | null> {
  const [row] = await db
    .select()
    .from(waves)
    .where(and(eq(waves.courseId, courseId), eq(waves.waveNumber, waveNumber)));
  return row ? waveRowGuard(row) : null;
}

/**
 * Read just the `chat_log` JSONB column for a Wave, Zod-validated.
 *
 * Optional `tx` opts the read into a caller's transaction so an append that
 * committed before the tx opened (or one made earlier in the same tx) is
 * visible. Used by `applyCloseGradings`: the learner's close-turn
 * `user.answers` entry lands on `chat_log` pre-LLM (see `prepareWaveTurn`),
 * AFTER `loadWaveContext` snapshots `ctx.wave.chatLog` — so the close-grading
 * path must re-read the live column to see the learner's MC click.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function getWaveChatLog(
  id: string,
  tx?: DbOrTx,
): Promise<readonly WaveChatLogEntry[]> {
  const exec = tx ?? db;
  const [row] = await exec.select({ chatLog: waves.chatLog }).from(waves).where(eq(waves.id, id));
  if (!row) throw new NotFoundError("wave", id);
  // Trust-boundary validation: the JSONB column is `unknown` on the Drizzle
  // row type; the schema parse is the same discipline as `waveRowGuard`.
  return waveChatLogSchema.parse(row.chatLog);
}

/**
 * Count a course's closed Waves inside the caller's tx. Each Wave close
 * awarded `WAVE.completionXp` once, so the course XP repair
 * (`recomputeCourseTotalXp`) multiplies by this count.
 */
export async function countClosedWavesInTx(courseId: string, tx: DbOrTx): Promise<number> {
  const [row] = await tx
    .select({ closed: count() })
    .from(waves)
    .where(and(eq(waves.courseId, courseId), eq(waves.status, "closed")));
  // An aggregate with no GROUP BY always returns one row.
  return row?.closed ?? 0;
}
