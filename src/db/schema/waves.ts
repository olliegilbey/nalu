import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { courses } from "./courses";

/**
 * `waves` — one row per teaching Wave (spec §3.4).
 *
 * Snapshot columns (`framework_snapshot`, `custom_instructions_snapshot`,
 * `due_concepts_snapshot`) freeze inputs at Wave start so a mid-Wave edit
 * elsewhere can't drift the rendered system prompt — byte-stability of the
 * cache prefix depends on it.
 *
 * `seed_source` is a discriminated-union JSONB:
 *   { kind: 'scoping_handoff' }                                // Wave 1
 *   { kind: 'prior_blueprint', priorWaveId, blueprint: {...} } // Wave N>1
 *
 * The blueprint is embedded (not referenced) so seed rendering is local.
 *
 * Partial unique index `waves_one_open_per_course` enforces "at most one
 * open Wave per course" at the DB level.
 */
export const waves = pgTable(
  "waves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    waveNumber: integer("wave_number").notNull(),
    tier: integer("tier").notNull(),
    frameworkSnapshot: jsonb("framework_snapshot").notNull(),
    customInstructionsSnapshot: text("custom_instructions_snapshot"),
    dueConceptsSnapshot: jsonb("due_concepts_snapshot").notNull(),
    seedSource: jsonb("seed_source").notNull(),
    turnBudget: integer("turn_budget").notNull(),
    status: text("status").notNull().default("open"),
    summary: text("summary"),
    blueprintEmitted: jsonb("blueprint_emitted"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    // Restrict status to known lifecycle values — DB-level guard against bad writes.
    check("waves_status_check", sql`${t.status} IN ('open','closed')`),
    // (course_id, wave_number) must be unique — each Wave has an unambiguous ordinal per course.
    uniqueIndex("waves_course_wave_number_unique").on(t.courseId, t.waveNumber),
    // Partial unique index: at most one open Wave per course — DB enforces the teaching invariant.
    uniqueIndex("waves_one_open_per_course")
      .on(t.courseId)
      .where(sql`${t.status} = 'open'`),
    // Positive ordinal invariants — wave 0 or tier 0 are never valid; turn budget of 0 is nonsense.
    check("waves_wave_number_positive", sql`${t.waveNumber} > 0`),
    check("waves_tier_positive", sql`${t.tier} > 0`),
    check("waves_turn_budget_positive", sql`${t.turnBudget} > 0`),
    // closed_at MUST be set iff status='closed'. Mirrors scoping_passes_closed_at_consistency.
    check(
      "waves_closed_at_consistency",
      sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
    ),
  ],
);

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type Wave = InferSelectModel<typeof waves>;

/**
 * Shape for INSERT statements.
 *
 * Required (notNull, no default): `courseId`, `waveNumber`, `tier`,
 * `frameworkSnapshot`, `dueConceptsSnapshot`, `seedSource`, `turnBudget`.
 *
 * Optional with server defaults: `id` (defaultRandom), `status` (default
 * 'open'), `openedAt` (defaultNow).
 *
 * Nullable (no default): `customInstructionsSnapshot`, `summary`,
 * `blueprintEmitted`, `closedAt`.
 */
export type WaveInsert = InferInsertModel<typeof waves>;

/** Zod schema for validating insert payloads at trust boundaries (e.g. API input). */
export const wavesInsertSchema = createInsertSchema(waves);

/** Zod schema for validating rows read from the DB. */
export const wavesSelectSchema = createSelectSchema(waves);
