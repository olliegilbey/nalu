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
import type { InferSelectModel } from "drizzle-orm";
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
 * failed_assistant_response@1, harness_retry_directive@2, assistant_response@3
 * on a turn that retried once).
 *
 * `role` is restricted to 'user' | 'assistant' | 'tool'. 'system' is
 * intentionally excluded — system content is rendered from seed columns at
 * send time and never persisted (principle P3).
 *
 * Each kind has exactly one role. `context_messages_kind_role_pair` pins it,
 * and so also enforces the role restriction above:
 *   - user: user_message, card_answer, harness_turn_counter,
 *     harness_review_block, harness_retry_directive.
 *   - assistant: assistant_response, failed_assistant_response,
 *     assistant_tool_call.
 *   - tool: tool_result.
 *
 * `kind` is the discriminator driving parsing/rendering; full
 * row→tag mapping is in spec §6.5:
 *   user_message, card_answer, assistant_response,
 *   harness_turn_counter, harness_review_block,
 *   failed_assistant_response, harness_retry_directive,
 *   assistant_tool_call, tool_result.
 * failed_assistant_response / harness_retry_directive are persisted by the
 * per-turn retry loops when an attempt fails its gate. Two writers fill
 * failed_assistant_response: executeTurn stores the raw output that failed
 * parsing; executeToolTurnStream stores the attempt's visible prose, cut at
 * the JSON leak (#140). harness_retry_directive = synthesised user-role
 * nudge to retry. They share
 * (parent, turn_index) with the original attempt and are filtered out of
 * successful turns by renderContext, but retained in DB so the LLM sees them
 * during a retry and terminal failures keep an audit trail.
 *
 * Tool-loop kinds (tool-calling migration, 2026-06-10 plan) — content is
 * JSON, serialized once at write time and parsed (never re-serialized) at
 * render so the cache prefix stays byte-stable:
 *   - `assistant_tool_call`: role='assistant', content =
 *     `{ "text": string, "toolCalls": [{ "toolCallId", "toolName", "input" }] }`
 *     — one row per assistant step that contained tool calls (text may be "").
 *     `input` is what the loop sent: `{}` for an invalid call whose input
 *     is not an object, such as unparseable arguments (#163). Rows written
 *     before #163 hold the raw string there.
 *   - `tool_result`: role='tool', content =
 *     `{ "results": [{ "toolCallId", "toolName", "output" | "errorText" }] }`
 *     — one row per step's results batch. `errorText` (a string) is a tool
 *     error, as the loop sent it (#147). Rows written before #147 hold a
 *     tool error as `"output": { "toolError": string }`.
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
      sql`${t.kind} IN (
        'user_message','card_answer','assistant_response',
        'harness_turn_counter','harness_review_block',
        'failed_assistant_response','harness_retry_directive',
        'assistant_tool_call','tool_result'
      )`,
    ),
    // Pin each kind to its one role. renderContext replays plain rows under their
    // stored role, so a mis-roled row would speak as the wrong party. It also owns
    // the role rule: no kind maps to 'system', so system content is never persisted (P3).
    // Postgres runs CHECKs in name order. kind_check sorts first and stays for its
    // sharper error name on an unknown kind; any bad role reports this constraint.
    check(
      "context_messages_kind_role_pair",
      sql`(${t.role} = 'user' AND ${t.kind} IN (
        'user_message','card_answer',
        'harness_turn_counter','harness_review_block','harness_retry_directive'
      ))
      OR (${t.role} = 'assistant' AND ${t.kind} IN (
        'assistant_response','failed_assistant_response','assistant_tool_call'
      ))
      OR (${t.role} = 'tool' AND ${t.kind} = 'tool_result')`,
    ),
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
).enableRLS();

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type ContextMessage = InferSelectModel<typeof contextMessages>;
