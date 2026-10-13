import { db, type DbOrTx } from "@/db/client";
import { contextMessages, type ContextMessage } from "@/db/schema";
import type { AppendMessageParams } from "./contextMessages";

/**
 * `context_messages` writes: single and batch append.
 *
 * Each append translates the `ContextParent` union into the nullable FK
 * columns the DB expects; the CHECK `context_messages_one_parent` rejects
 * any row with both or neither set.
 */

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
