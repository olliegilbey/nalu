import { and, asc, desc, eq, max } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { contextMessages, type ContextMessage } from "@/db/schema";

/**
 * `context_messages` query surface (spec §3.5): shared types and reads.
 *
 * Polymorphic parent expressed as a discriminated union at the TS layer.
 * The DB CHECK constraint `context_messages_one_parent` guarantees exactly
 * one of `wave_id` / `scoping_pass_id` is non-null per row.
 *
 * Ordering convention: rows within a parent are always returned
 * `(turn_index ASC, seq ASC)` so callers reconstruct the message list in
 * the exact order they were appended — required for stable context rendering.
 *
 * `getNextTurnIndex` returns 0 when no rows exist (first turn is index 0)
 * matching the spec's 0-based turn convention.
 *
 * Appends live in `contextMessages.writes.ts`.
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
 * Each message `kind` (how the message was produced) with its one LLM
 * role, as one union keyed on `kind`.
 *
 * Mirrors the DB CHECK `context_messages_kind_role_pair` exactly, so tsc
 * rejects a pair the DB would reject at insert. No kind maps to 'system':
 * system content is never persisted (P3).
 */
type ContextMessageKindRole =
  | { readonly kind: "user_message"; readonly role: "user" }
  | { readonly kind: "card_answer"; readonly role: "user" }
  | { readonly kind: "harness_turn_counter"; readonly role: "user" }
  | { readonly kind: "harness_review_block"; readonly role: "user" }
  | { readonly kind: "harness_retry_directive"; readonly role: "user" }
  | { readonly kind: "assistant_response"; readonly role: "assistant" }
  | { readonly kind: "failed_assistant_response"; readonly role: "assistant" }
  | { readonly kind: "assistant_tool_call"; readonly role: "assistant" }
  | { readonly kind: "tool_result"; readonly role: "tool" };

/**
 * Parameters for inserting a single context message row.
 *
 * `kind` and `role` come as one legal pair (`ContextMessageKindRole`);
 * `schema.integration.test.ts` pins that union to the DB CHECK.
 */
export type AppendMessageParams = ContextMessageKindRole & {
  /** Polymorphic parent — exactly one FK column will be set. */
  readonly parent: ContextParent;
  /** 0-based turn index within the parent Wave or scoping pass. */
  readonly turnIndex: number;
  /** Position within the turn (multiple rows can share a turn_index). */
  readonly seq: number;
  /** Raw text content of the message. */
  readonly content: string;
};

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
 * Hardening is deferred (issue #53).
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
 * Return the newest `assistant_response` row for a Wave (highest
 * `turn_index`), or `null` when the Wave has none.
 *
 * The mid-turn transaction reads the row the turn runner just persisted:
 * its id becomes the questionnaire id, its turn index the assessments' turn.
 * `tx` runs the read inside that transaction.
 */
export async function getLatestAssistantResponseForWaveInTx(
  waveId: string,
  tx: DbOrTx,
): Promise<{ readonly id: string; readonly turnIndex: number } | null> {
  const [row] = await tx
    .select({ id: contextMessages.id, turnIndex: contextMessages.turnIndex })
    .from(contextMessages)
    .where(and(eq(contextMessages.waveId, waveId), eq(contextMessages.kind, "assistant_response")))
    .orderBy(desc(contextMessages.turnIndex))
    .limit(1);
  return row ?? null;
}
