import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  timestamp,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { waves } from "./waves";
import { scopingPasses } from "./scopingPasses";

/**
 * `context_messages` — append-only log of every message in a Wave's or
 * scoping pass's LLM Context (spec §3.5).
 *
 * Polymorphic XOR parent: exactly one of `wave_id` / `scoping_pass_id` is
 * non-null per row; the CHECK constraint `context_messages_one_parent`
 * enforces this at the DB level.
 *
 * `turn_index` is per-turn, not per-LLM-call — retries within the same turn
 * reuse the same `turn_index` (spec §9.2).
 *
 * `seq` orders rows within a turn (e.g. user_message@0,
 * harness_turn_counter@1, harness_review_block@2 on a Wave's final turn).
 *
 * `role` is restricted to 'user' | 'assistant' | 'tool'. 'system' is
 * intentionally excluded — system content is rendered from seed columns at
 * send time and never persisted (principle P3).
 *
 * `kind` is the discriminator driving parsing/rendering; full
 * row→tag mapping is in spec §6.5:
 *   user_message, card_answer, assistant_response,
 *   harness_turn_counter, harness_review_block.
 *
 * Two partial unique indexes enforce (turn_index, seq) ordering uniqueness
 * scoped to each parent type without conflicting across the XOR.
 */
export const contextMessages = pgTable(
  "context_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    waveId: uuid("wave_id").references(() => waves.id, { onDelete: "cascade" }),
    scopingPassId: uuid("scoping_pass_id").references(() => scopingPasses.id, {
      onDelete: "cascade",
    }),
    turnIndex: integer("turn_index").notNull(),
    seq: smallint("seq").notNull(),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Restrict kind to known discriminator values — guards against unrecognised message types.
    check(
      "context_messages_kind_check",
      sql`${t.kind} IN ('user_message','card_answer','assistant_response','harness_turn_counter','harness_review_block')`,
    ),
    // Restrict role to known LLM roles — 'system' excluded; system content is never persisted (P3).
    check("context_messages_role_check", sql`${t.role} IN ('user','assistant','tool')`),
    // XOR parent: exactly one of wave_id / scoping_pass_id must be non-null per row.
    check(
      "context_messages_one_parent",
      sql`(${t.waveId} IS NOT NULL) <> (${t.scopingPassId} IS NOT NULL)`,
    ),
    // Partial unique index for wave-scoped messages — ensures (wave_id, turn_index, seq) is unique.
    uniqueIndex("context_messages_wave_order")
      .on(t.waveId, t.turnIndex, t.seq)
      .where(sql`${t.waveId} IS NOT NULL`),
    // Partial unique index for scoping-pass messages — ensures (scoping_pass_id, turn_index, seq) is unique.
    uniqueIndex("context_messages_scoping_order")
      .on(t.scopingPassId, t.turnIndex, t.seq)
      .where(sql`${t.scopingPassId} IS NOT NULL`),
    // turn_index and seq are logical positions — negative values are nonsense.
    check("context_messages_turn_index_nonneg", sql`${t.turnIndex} >= 0`),
    check("context_messages_seq_nonneg", sql`${t.seq} >= 0`),
  ],
);

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type ContextMessage = InferSelectModel<typeof contextMessages>;

/**
 * Shape for INSERT statements.
 *
 * Required (notNull, no default): `turnIndex`, `seq`, `kind`, `role`, `content`.
 *
 * Optional with server defaults: `id` (defaultRandom), `createdAt` (defaultNow).
 *
 * Nullable (no default, polymorphic): `waveId`, `scopingPassId`. Exactly one
 * of `waveId` / `scopingPassId` must be set per row (CHECK enforces this);
 * both are column-nullable so the type marks them optional, but inserts
 * violating the XOR will be rejected by the DB.
 */
export type ContextMessageInsert = InferInsertModel<typeof contextMessages>;

/** Zod schema for validating insert payloads at trust boundaries (e.g. API input). */
export const contextMessagesInsertSchema = createInsertSchema(contextMessages);

/** Zod schema for validating rows read from the DB. */
export const contextMessagesSelectSchema = createSelectSchema(contextMessages);
