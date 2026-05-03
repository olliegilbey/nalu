import { pgTable, uuid, text, timestamp, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { courses } from "./courses";

/**
 * `scoping_passes` — one row per onboarding Context (spec §3.3).
 *
 * UNIQUE on `course_id`: at most one scoping pass per course (MVP).
 * Drop the unique constraint if we ever support re-scoping.
 *
 * Scoping is multi-turn, byte-stable, append-only — same Context discipline
 * as a Wave (P7). Rows in `context_messages` reference this id when the
 * parent is scoping.
 */
export const scopingPasses = pgTable(
  "scoping_passes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    // Restrict status to known lifecycle values — DB-level guard against bad writes.
    check("scoping_passes_status_check", sql`${t.status} IN ('open','closed')`),
    // closed_at MUST be set iff status='closed'. Catches partial closes from
    // any future writer that bypasses closeScopingPass().
    check(
      "scoping_passes_closed_at_consistency",
      sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
    ),
    // One scoping pass per course (MVP) — uniqueness enforced at DB level, not app layer.
    uniqueIndex("scoping_passes_course_id_unique").on(t.courseId),
  ],
);

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type ScopingPass = InferSelectModel<typeof scopingPasses>;

/**
 * Shape for INSERT statements. `courseId` is required (notNull, no default).
 * All other columns are optional: `id` defaults to a random UUID; `status`
 * defaults to 'open'; `openedAt` defaults to now(); `closedAt` is nullable.
 */
export type ScopingPassInsert = InferInsertModel<typeof scopingPasses>;

/** Zod schema for validating insert payloads at trust boundaries (e.g. API input). */
export const scopingPassesInsertSchema = createInsertSchema(scopingPasses);

/** Zod schema for validating rows read from the DB. */
export const scopingPassesSelectSchema = createSelectSchema(scopingPasses);
