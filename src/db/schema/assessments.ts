import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { waves } from "./waves";
import { concepts } from "./concepts";

/**
 * `assessments` — in-Wave probes that earn XP (spec §3.7).
 *
 * Baseline gradings are NOT stored here; they live in `courses.baseline` and
 * seed per-concept SM-2 state in `concepts` (spec §3 decisions).
 *
 * `question` is nullable to support `inferred` rows, where the correctness
 * signal arrives from the model's read of free-form dialogue rather than a
 * posed question. For `inferred` rows, `user_answer` is the user's prior
 * message text — the prose that produced the signal.
 *
 * The CHECK `assessments_question_required_for_card_kinds` enforces the
 * application-layer invariant: `card_mc` and `card_freetext` rows must carry
 * the question text so it can be rendered and audited; `inferred` rows may
 * omit it.
 *
 * `question_id` is the question identifier namespaced per questionnaire as
 * `${questionnaireId}:${rawId}` via `namespaceQuestionId` — NOT the raw
 * model-generated id. The model emits short ids (`q1`/`q2`) and restarts
 * numbering per questionnaire, so raw ids are not wave-unique; namespacing
 * makes them so. Nullable because `inferred` rows have no posed question.
 * A partial unique index (`assessments_wave_question_unique`) on
 * `(wave_id, question_id)` enforces that wave-uniqueness, and a CHECK
 * (`assessments_question_id_required_for_card_kinds`) mirrors the existing
 * `question` invariant: card kinds must carry a `question_id` so the grading
 * step can find the row to update via `getAssessmentByWaveAndQuestionId`
 * (which namespaces its lookup with the same helper).
 */
export const assessments = pgTable(
  "assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    waveId: uuid("wave_id")
      .notNull()
      .references(() => waves.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    question: text("question"),
    // Question identifier namespaced per questionnaire (`${questionnaireId}:${rawId}`
    // via `namespaceQuestionId`) so model-reused ids don't collide within a wave.
    // Nullable to keep `inferred` rows valid; the CHECK
    // `assessments_question_id_required_for_card_kinds` enforces presence for card
    // kinds.
    questionId: text("question_id"),
    userAnswer: text("user_answer").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    qualityScore: integer("quality_score").notNull(),
    assessmentKind: text("assessment_kind").notNull(),
    xpAwarded: integer("xp_awarded").notNull().default(0),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Restrict assessmentKind to known probe types; DB-level guard against bad writes.
    check(
      "assessments_kind_check",
      sql`${t.assessmentKind} IN ('card_mc','card_freetext','inferred')`,
    ),
    // `inferred` rows may have null `question`; card kinds must carry the prompt text so we can render and audit it later.
    check(
      "assessments_question_required_for_card_kinds",
      sql`${t.assessmentKind} = 'inferred' OR ${t.question} IS NOT NULL`,
    ),
    // Mirror of the `question` invariant for the model-generated id: card kinds
    // must carry a question_id (the mid-turn orchestrator finds the row to
    // grade via wave_id + question_id); `inferred` rows have no posed question.
    check(
      "assessments_question_id_required_for_card_kinds",
      sql`${t.assessmentKind} = 'inferred' OR ${t.questionId} IS NOT NULL`,
    ),
    // Partial unique index: prevents the mid-turn orchestrator from inserting
    // duplicate rows for the same model question id within a wave. `inferred`
    // rows are excluded via the WHERE clause (their question_id is null).
    uniqueIndex("assessments_wave_question_unique")
      .on(t.waveId, t.questionId)
      .where(sql`${t.questionId} IS NOT NULL`),
    // Supports per-Wave aggregation (XP totals, Wave summary).
    index("assessments_wave_id_idx").on(t.waveId),
    // Supports per-concept timeline reads (last-N assessments for a concept).
    index("assessments_concept_assessed_idx").on(t.conceptId, t.assessedAt),
    // turn_index is a logical position — negative values are nonsense.
    check("assessments_turn_index_nonneg", sql`${t.turnIndex} >= 0`),
    // Quality score follows the SM-2 scale 0–5 exactly.
    check(
      "assessments_quality_score_range",
      sql`${t.qualityScore} >= 0 AND ${t.qualityScore} <= 5`,
    ),
    // XP can be zero (e.g. incorrect answer) but never negative.
    check("assessments_xp_awarded_nonneg", sql`${t.xpAwarded} >= 0`),
  ],
);

/** Use in query-layer return signatures so callers never import drizzle internals. */
export type Assessment = InferSelectModel<typeof assessments>;

/**
 * Shape for INSERT statements.
 *
 * Required (notNull, no default): `waveId`, `conceptId`, `turnIndex`,
 * `userAnswer`, `isCorrect`, `qualityScore`, `assessmentKind`.
 *
 * Optional with server defaults: `id` (defaultRandom), `xpAwarded`
 * (default 0), `assessedAt` (defaultNow).
 *
 * Nullable (no default): `question` — required at the application layer for
 * `card_mc`/`card_freetext` rows (the CHECK
 * `assessments_question_required_for_card_kinds` enforces it at the DB level),
 * but the column is nullable to allow `inferred` rows where the correctness
 * signal comes from free-form dialogue with no posed question.
 */
export type AssessmentInsert = InferInsertModel<typeof assessments>;

/** Zod schema for validating insert payloads at trust boundaries (e.g. API input). */
export const assessmentsInsertSchema = createInsertSchema(assessments);

/** Zod schema for validating rows read from the DB. */
export const assessmentsSelectSchema = createSelectSchema(assessments);
