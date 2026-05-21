import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { WAVE } from "@/lib/config/tuning";
import { appendWaveChatLog, closeWave, openWave } from "@/db/queries/waves";
import { getConceptsByCourse, getDueConceptsByCourse } from "@/db/queries/concepts";
import { appendMessage } from "@/db/queries/contextMessages";
import { dueConceptsSnapshotSchema, type FrameworkJsonb } from "@/lib/types/jsonb";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { LoadedWaveContext } from "./loadWaveContext";
import { applySm2Update } from "./applySm2Update";
import {
  applyCloseGradings,
  maybeAdvanceTier,
  type PersistedGradedSignal,
} from "./persistWaveClose.helpers";

/**
 * Re-exported from `persistWaveClose.helpers` so callers import the
 * close-turn graded-signal shape (`kind`, `questionId`, `xpAwarded`) from
 * this module's public surface.
 */
export type { PersistedGradedSignal };

/** Inputs to {@link persistWaveClose}. */
export interface PersistWaveCloseParams {
  readonly ctx: LoadedWaveContext;
  readonly parsed: WaveCloseTurn;
  /** Caller-supplied reference time threaded through SM-2 updates + Wave N+1 snapshot. */
  readonly now: Date;
}

/** Result handle — used by the orchestrator projection. */
export interface PersistWaveCloseResult {
  readonly nextWaveId: string;
  readonly nextWaveNumber: number;
  readonly completionXpAwarded: number;
  /** New currentTier if advancement fired this close; null when unchanged. */
  readonly tierAdvancedTo: number | null;
  readonly gradedSignals: readonly PersistedGradedSignal[];
}

/**
 * Transactional close body: applies gradings + SM-2 updates, closes Wave N,
 * optionally advances current_tier, opens Wave N+1, seeds the opening message,
 * and bumps total_xp. All-or-nothing — any failure rolls every step back.
 *
 * Ordering (top → bottom):
 *   1. Apply close `gradings[]` via `applyCloseGradings` (helpers.ts).
 *   2. Apply `conceptUpdates[]` via `applySm2Update` per concept.
 *   3. `closeWave(...)` — UPDATE goes through the SAME tx (closeWave accepts
 *      optional tx, mirroring openWave) so the close rolls back if a later
 *      step throws. Without the tx thread, the UPDATE would commit even when
 *      the orchestrator's openWave(N+1) hits a unique-violation.
 *   4. Tier-advancement check — gated by
 *        (waveNumber % WAVE.tierCheckInterval === 0)
 *        || (plannedConcepts.length === 0)
 *      The consolidation gate (empty plannedConcepts) overrides the modulo
 *      gate. On advance, `maybeAdvanceTier` bumps `current_tier` via raw
 *      `tx.execute` (same rationale as persistScopingClose).
 *   5. Open Wave N+1 with `seed_source.prior_blueprint` carrying the just-
 *      emitted blueprint and a fresh `dueConceptsSnapshot` taken via the SAME
 *      tx so SM-2 advances from step 2 are reflected.
 *   6. Insert turn-0 assistant message on Wave N+1 carrying `openingText`.
 *   7. Bump `courses.total_xp` by `WAVE.completionXp` (flat reward).
 *
 * Mirrors `persistScopingClose` for the raw-SQL transactional update style on
 * the `courses` row (`tx.execute(sql\`UPDATE courses ...\`)`) — the helpers
 * `incrementCourseXp` / `updateCourseTier` use the `db` singleton and would
 * deadlock against this tx's row lock.
 */
export async function persistWaveClose(
  params: PersistWaveCloseParams,
): Promise<PersistWaveCloseResult> {
  const { ctx, parsed, now } = params;

  return db.transaction(async (tx) => {
    // 1. Apply per-question gradings.
    const gradedSignals = await applyCloseGradings(tx, ctx, parsed);

    // 2. Apply SM-2 updates. Reads via tx so step-3 close + step-5 dueSnapshot
    //    see the just-applied next_review_at writes.
    for (const update of parsed.conceptUpdates) {
      await applySm2Update({
        courseId: ctx.course.id,
        name: update.name,
        qualityScore: update.qualityScore,
        now,
        tx,
      });
    }

    // 3. Close Wave N. Tx-threaded so rollback wipes the close UPDATE if
    //    openWave(N+1) below trips either the partial open-index or the
    //    (course_id, wave_number) unique index.
    await closeWave(
      ctx.wave.id,
      { summary: parsed.summary, blueprintEmitted: parsed.nextUnitBlueprint },
      tx,
    );

    // 3b. Closing assistant entry on Wave N's chat_log — paired with the
    //     close-turn assistant_response that was persisted by executeTurn in
    //     the parent executeWaveClose. Same two-store invariant as mid-turn
    //     (see executeWaveMid): context_messages = LLM replay log;
    //     chat_log = wave UI's typed source of truth.
    await appendWaveChatLog(tx, ctx.wave.id, {
      role: "assistant",
      kind: "text",
      content: parsed.userMessage,
    });

    // 4. Gated tier-advancement check. Two gates ORed: scheduled interval
    //    modulo OR consolidation (empty plannedConcepts). The consolidation
    //    gate is the failsafe — a wave that spent its time consolidating
    //    should always check whether the learner is ready to advance.
    const moduloGateOpen = ctx.wave.waveNumber % WAVE.tierCheckInterval === 0;
    const consolidationGateOpen = parsed.nextUnitBlueprint.plannedConcepts.length === 0;
    const tierCheckRuns = moduloGateOpen || consolidationGateOpen;

    // Pull concepts via tx so step-2 SM-2 advances are visible. The helper
    // filters to current tier + non-null lastQualityScore internally.
    const allConcepts = await getConceptsByCourse(ctx.course.id, tx);
    const currentTier = ctx.course.currentTier;
    const tierAdvancedTo = tierCheckRuns
      ? await maybeAdvanceTier(tx, ctx.course.id, currentTier, allConcepts)
      : null;
    const newCurrentTier = tierAdvancedTo ?? currentTier;

    // 5. Capture due snapshot for Wave N+1 — via tx so step-2's next_review_at
    //    writes are reflected. Parse-before-persist routes the raw
    //    `lastQualityScore: number | null` through the schema so any stored
    //    value outside [0,5] surfaces here, not as a downstream Zod failure.
    const dueConcepts = await getDueConceptsByCourse(ctx.course.id, now, tx);
    const dueConceptsSnapshot = dueConceptsSnapshotSchema.parse(
      dueConcepts.map((c) => ({
        conceptId: c.id,
        name: c.name,
        tier: c.tier,
        lastQuality: c.lastQualityScore,
      })),
    );

    // 6. Open Wave N+1. Same frameworkSnapshot as Wave N — frameworks are
    //    course-level, not wave-mutating, so re-snapshotting from the
    //    closing wave is plan-faithful.
    const nextWaveNumber = ctx.wave.waveNumber + 1;
    const nextWave = await openWave(
      {
        courseId: ctx.course.id,
        waveNumber: nextWaveNumber,
        tier: newCurrentTier,
        frameworkSnapshot: ctx.wave.frameworkSnapshot as FrameworkJsonb,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot,
        seedSource: {
          kind: "prior_blueprint",
          priorWaveId: ctx.wave.id,
          blueprint: parsed.nextUnitBlueprint,
        },
        turnBudget: WAVE.turnCount,
      },
      tx,
    );

    // 7. Seed Wave N+1 turn-0 assistant message carrying openingText.
    await appendMessage(
      {
        parent: { kind: "wave", id: nextWave.id },
        turnIndex: 0,
        seq: 0,
        kind: "assistant_response",
        role: "assistant",
        content: parsed.nextUnitBlueprint.openingText,
      },
      tx,
    );

    // 7b. Opening assistant entry on Wave N+1's chat_log. Mirror of step 7's
    //     context_messages seed: that one is the LLM replay log; this one is
    //     the wave UI's typed source of truth.
    await appendWaveChatLog(tx, nextWave.id, {
      role: "assistant",
      kind: "text",
      content: parsed.nextUnitBlueprint.openingText,
    });

    // 8. Bump total_xp by completionXp. Inline raw UPDATE rather than
    //    `incrementCourseXp` (singleton-bound).
    await tx.execute(sql`
      UPDATE courses
      SET total_xp = total_xp + ${WAVE.completionXp},
          updated_at = NOW()
      WHERE id = ${ctx.course.id}
    `);

    return {
      nextWaveId: nextWave.id,
      nextWaveNumber,
      completionXpAwarded: WAVE.completionXp,
      tierAdvancedTo,
      gradedSignals,
    } as const;
  });
}
