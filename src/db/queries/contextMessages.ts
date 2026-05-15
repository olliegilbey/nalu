import { and, asc, desc, eq, max } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { contextMessages, type ContextMessage } from "@/db/schema";
import { assessmentSchema, type AssessmentCard } from "@/lib/llm/tagVocabulary";
import { extractTag } from "@/lib/llm/extractTag";

/**
 * `context_messages` query surface (spec §3.5).
 *
 * Polymorphic parent expressed as a discriminated union at the TS layer.
 * The DB CHECK constraint `context_messages_one_parent` guarantees exactly
 * one of `wave_id` / `scoping_pass_id` is non-null per row; this layer
 * translates the union into the correct nullable FK column values on insert.
 *
 * Ordering convention: rows within a parent are always returned
 * `(turn_index ASC, seq ASC)` so callers reconstruct the message list in
 * the exact order they were appended — required for stable context rendering.
 *
 * `getNextTurnIndex` returns 0 when no rows exist (first turn is index 0)
 * matching the spec's 0-based turn convention.
 *
 * `getLastAssessmentCard` extracts the most recent `<assessment>` tag from
 * the latest `assistant_response` row — used by the card-answer turn path
 * to look up correct answers without re-querying the LLM (spec §9.3 §2b).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the polymorphic parent of a context
 * message. Exactly one variant must be supplied per `appendMessage` call.
 */
export type ContextParent =
  | { readonly kind: "wave"; readonly id: string }
  | { readonly kind: "scoping"; readonly id: string };

/**
 * Parameters for inserting a single context message row.
 *
 * `kind` and `role` mirror the DB CHECK constraints:
 *   - kind: 5 discriminator values tracking how the message was produced.
 *   - role: 'user' | 'assistant' | 'tool' (no 'system' — P3 principle).
 */
export interface AppendMessageParams {
  /** Polymorphic parent — exactly one FK column will be set. */
  readonly parent: ContextParent;
  /** 0-based turn index within the parent Wave or scoping pass. */
  readonly turnIndex: number;
  /** Position within the turn (multiple rows can share a turn_index). */
  readonly seq: number;
  /** Discriminator for how/why this message was produced. */
  readonly kind:
    | "user_message"
    | "card_answer"
    | "assistant_response"
    | "harness_turn_counter"
    | "harness_review_block"
    | "failed_assistant_response"
    | "harness_retry_directive";
  /** LLM role — 'system' excluded; system content is never persisted (P3). */
  readonly role: "user" | "assistant" | "tool";
  /** Raw text content of the message. */
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Append a single message row to a Wave or scoping pass context.
 *
 * Translates the `ContextParent` discriminated union into the nullable FK
 * columns the DB expects. The XOR CHECK constraint will reject any attempt
 * to set both or neither parent column — this function always sets exactly one.
 *
 * Optional `tx` opts the INSERT into a caller's transaction so the message
 * row rolls back atomically with sibling writes.
 *
 * @throws {Error} if the insert returns no row (should never happen on success).
 */
export async function appendMessage(
  params: AppendMessageParams,
  tx?: DbOrTx,
): Promise<ContextMessage> {
  const exec = tx ?? db;
  const [row] = await exec
    .insert(contextMessages)
    .values({
      // XOR: set only the FK matching the parent kind; leave the other null.
      waveId: params.parent.kind === "wave" ? params.parent.id : null,
      scopingPassId: params.parent.kind === "scoping" ? params.parent.id : null,
      turnIndex: params.turnIndex,
      seq: params.seq,
      kind: params.kind,
      role: params.role,
      content: params.content,
    })
    .returning();
  // The insert must return a row on success — no scenario where it doesn't.
  if (!row) throw new Error("appendMessage: insert returned no row");
  return row;
}

/**
 * Atomically append a batch of context messages.
 *
 * Implementation: one multi-VALUES INSERT — Postgres rejects any row that
 * violates a constraint and rolls back the whole statement. No explicit
 * transaction wrapper required; the single-statement guarantee is the
 * atomicity boundary.
 *
 * Use this when a turn produces multiple rows (e.g. user_message +
 * assistant_response, or the full retry trail: user_message +
 * failed_assistant_response + harness_retry_directive + assistant_response).
 */
export async function appendMessages(
  params: readonly AppendMessageParams[],
): Promise<readonly ContextMessage[]> {
  // Defensive: a zero-length INSERT would either be a no-op or a SQL error
  // depending on the driver; treat empty input as a programming bug.
  if (params.length === 0) throw new Error("appendMessages: empty batch");

  const rows = await db
    .insert(contextMessages)
    .values(
      params.map((p) => ({
        // XOR FK mapping mirrors appendMessage: exactly one parent FK is set
        // per row; the DB CHECK constraint enforces this invariant.
        waveId: p.parent.kind === "wave" ? p.parent.id : null,
        scopingPassId: p.parent.kind === "scoping" ? p.parent.id : null,
        turnIndex: p.turnIndex,
        seq: p.seq,
        kind: p.kind,
        role: p.role,
        content: p.content,
      })),
    )
    .returning();
  // Sanity check: RETURNING should yield one row per input row. A mismatch
  // would indicate a driver-level filter or partial failure we did not catch.
  if (rows.length !== params.length) {
    throw new Error(`appendMessages: expected ${params.length} rows returned, got ${rows.length}`);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Return all messages for a Wave, ordered by `(turn_index ASC, seq ASC)`.
 *
 * This ordering is stable across calls so consumers receive the context in
 * the exact append order — required for byte-stable rendering (spec §4.2).
 */
export async function getMessagesForWave(waveId: string): Promise<readonly ContextMessage[]> {
  return db
    .select()
    .from(contextMessages)
    .where(eq(contextMessages.waveId, waveId))
    .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));
}

/**
 * Return all messages for a scoping pass, ordered by `(turn_index ASC, seq ASC)`.
 *
 * Scoped strictly to `scoping_pass_id` — never overlaps with wave messages
 * even when the scoping pass and wave belong to the same course.
 */
export async function getMessagesForScopingPass(
  scopingPassId: string,
): Promise<readonly ContextMessage[]> {
  return db
    .select()
    .from(contextMessages)
    .where(eq(contextMessages.scopingPassId, scopingPassId))
    .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));
}

/**
 * Return the next monotonically-increasing turn_index for a context parent.
 *
 * Read-then-insert race precondition: two concurrent callers will compute
 * the same next index and the second insert will violate the partial unique
 * index on (parent, turn_index, seq). The MVP harness loop is single-user-
 * per-Wave, so concurrent writers cannot happen in practice. If the harness
 * ever gains parallel write paths, this function must move to a SERIALIZABLE
 * transaction or be replaced by a Postgres sequence per parent.
 *
 * See docs/TODO.md → "getNextTurnIndex race".
 */
export async function getNextTurnIndex(parent: ContextParent): Promise<number> {
  // Build the WHERE clause from the discriminated union.
  const cond =
    parent.kind === "wave"
      ? eq(contextMessages.waveId, parent.id)
      : eq(contextMessages.scopingPassId, parent.id);

  const [row] = await db
    .select({ maxTurnIndex: max(contextMessages.turnIndex) })
    .from(contextMessages)
    .where(cond);

  // `max()` returns null when no rows match; treat as -1 so +1 gives 0.
  const current = row?.maxTurnIndex ?? null;
  return current === null ? 0 : current + 1;
}

/**
 * Extract and validate the most recent `<assessment>` tag from the latest
 * `assistant_response` row for `waveId`.
 *
 * Used by the harness when processing a card-answer turn to look up the
 * correct answer without a second LLM call (spec §9.3 step 2b).
 *
 * Returns `null` when:
 *   - No `assistant_response` rows exist for the wave.
 *   - The latest response has no `<assessment>` tag.
 *   - The tag body is not valid JSON (JSON.parse throws → caught here).
 *   - The parsed JSON does not satisfy `assessmentSchema` (safeParse fails).
 */
export async function getLastAssessmentCard(waveId: string): Promise<AssessmentCard | null> {
  // Most recent assistant_response by (turn_index DESC, seq DESC).
  const [row] = await db
    .select()
    .from(contextMessages)
    .where(and(eq(contextMessages.waveId, waveId), eq(contextMessages.kind, "assistant_response")))
    .orderBy(desc(contextMessages.turnIndex), desc(contextMessages.seq))
    .limit(1);

  if (!row) return null;

  // Extract the XML tag body; returns null if tag is absent or unclosed.
  const tag = extractTag(row.content, "assessment");
  if (!tag) return null;

  // JSON.parse throws on malformed input — wrap to ensure null return instead.
  try {
    const parsed = assessmentSchema.safeParse(JSON.parse(tag));
    return parsed.success ? parsed.data : null;
  } catch {
    // JSON.parse threw; the tag body was not valid JSON.
    return null;
  }
}
