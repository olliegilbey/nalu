import { TRPCError } from "@trpc/server";
import { db } from "@/db/client";
import { WAVE } from "@/lib/config/tuning";
import { appendWaveChatLog, closeWave, openWave } from "@/db/queries/waves.writes";
import { getConceptsByCourse, getDueConceptsByCourse } from "@/db/queries/concepts";
import { appendMessage } from "@/db/queries/contextMessages.writes";
import { getCourseOwnerCustomInstructionsInTx } from "@/db/queries/userProfiles";
import {
  getCourseTotalXpInTx,
  incrementCourseXpInTx,
  lockCourseRowInTx,
  setCourseSummaryInTx,
} from "@/db/queries/courses.tx";
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
  /** Course XP after this request: `courses.total_xp`, never a delta. */
  readonly totalXp: number;
}

/**
 * Transactional close body: closes Wave N, applies gradings + SM-2 updates,
 * rewrites the course summary, optionally advances current_tier, opens Wave
 * N+1, seeds the opening message, bumps total_xp, and reads it back.
 * All-or-nothing — any failure rolls every step back.
 *
 * Ordering (top → bottom):
 *   0. Lock the course row (`lockCourseRowInTx`) before any Wave or
 *      assessment row. A concurrent mid-turn save takes the same first lock,
 *      so the two queue instead of deadlocking (lock order:
 *      `src/db/queries/CLAUDE.md`).
 *   1. `closeWave(...)` — UPDATE goes through the SAME tx (closeWave accepts
 *      optional tx, mirroring openWave) so the close rolls back if a later
 *      step throws. Without the tx thread, the UPDATE would commit even when
 *      the orchestrator's openWave(N+1) hits a unique-violation. It runs
 *      first so a close that closes nothing (another path closed Wave N)
 *      throws `PRECONDITION_FAILED` before any other write.
 *   2. Apply close `gradings[]` via `applyCloseGradings` (helpers.ts). Each
 *      grading also adds its XP to `courses.total_xp`.
 *   3. Apply `conceptUpdates[]` via `applySm2Update` per concept.
 *   3a. Rewrite `courses.summary` with the close's summary
 *      (`setCourseSummaryInTx`). Wave N+1's `<progress_summary>` renders it.
 *   3b. Append the closing assistant entry to Wave N's `chat_log`.
 *   4. Tier-advancement check — gated by
 *        (waveNumber % WAVE.tierCheckInterval === 0)
 *        || (plannedConcepts.length === 0)
 *      The consolidation gate (empty plannedConcepts) overrides the modulo
 *      gate. On advance, `maybeAdvanceTier` bumps `current_tier` via
 *      `updateCourseTierInTx`.
 *   5. Take a fresh `dueConceptsSnapshot` for Wave N+1 via the SAME tx, so
 *      SM-2 advances from step 3 are reflected.
 *   6. Open Wave N+1 with `seed_source.prior_blueprint` carrying the just-
 *      emitted blueprint, the step-5 due snapshot, and the learner's current
 *      custom instructions as its snapshot.
 *   7. Insert turn-0 assistant message on Wave N+1 carrying `openingText`.
 *   7b. Append the same opening entry to Wave N+1's `chat_log`.
 *   8. Bump `courses.total_xp` by `WAVE.completionXp` (flat reward).
 *   9. Read `courses.total_xp` back for the turn result (`totalXp`).
 *
 * Like `persistScopingClose`, every `courses` write goes through the tx
 * helpers in `@/db/queries/courses.tx`. A write on the `db` singleton would
 * deadlock against this tx's row lock.
 */
export async function persistWaveClose(
  params: PersistWaveCloseParams,
): Promise<PersistWaveCloseResult> {
  const { ctx, parsed, now } = params;

  return db.transaction(async (tx) => {
    // 0. Course row first: the gradings and the completion bump below both
    //    write `courses.total_xp`.
    await lockCourseRowInTx(ctx.course.id, tx);

    // 1. Close Wave N. Tx-threaded so rollback wipes the close UPDATE if
    //    openWave(N+1) below trips either the partial open-index or the
    //    (course_id, wave_number) unique index.
    const { wave: closingWave, closedNow } = await closeWave(
      ctx.wave.id,
      { summary: parsed.summary, blueprintEmitted: parsed.nextUnitBlueprint },
      tx,
    );
    // Another path closed Wave N after this turn passed `prepareWaveTurn`.
    // Fail explicitly before any grading, SM-2, summary or Wave N+1 write;
    // the throw rolls the tx back. Same code and message shape as
    // `prepareWaveTurn`'s closed-Wave guard, so `clientErrorText` passes it.
    if (!closedNow) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `wave ${ctx.wave.id} is not open (status='${closingWave.status}')`,
      });
    }

    // 2. Apply per-question gradings.
    const gradedSignals = await applyCloseGradings(tx, ctx, parsed);

    // 3. Apply SM-2 updates. Reads via tx so the step-5 dueSnapshot sees the
    //    just-applied next_review_at writes.
    for (const update of parsed.conceptUpdates) {
      await applySm2Update({
        courseId: ctx.course.id,
        name: update.name,
        qualityScore: update.qualityScore,
        now,
        tx,
      });
    }

    // 3a. Rewrite the course summary. The close schema asks the model for the
    //     whole course summary, so this overwrites; it never appends. Wave N
    //     keeps the same text in `waves.summary` (step 1) as its snapshot.
    //     Byte stability: every Wave turn renders `courses.summary` into its
    //     system prompt, read once per turn. That is safe only because this
    //     write runs at close. Wave N takes no more turns, so only Wave N+1's
    //     prompt ever sees the new value. It also leans on the read order in
    //     `loadWaveContext`: course row first, then the Wave's open check.
    await setCourseSummaryInTx(ctx.course.id, parsed.summary, tx);

    // 3b. Closing assistant entry on Wave N's chat_log — paired with the
    //     close-turn assistant_response that was persisted by executeTurn in
    //     the parent executeWaveClose. Same two-store invariant as mid-turn
    //     (see persistWaveMidTurn): context_messages = LLM replay log;
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

    // Pull concepts via tx so step-3 SM-2 advances are visible. The helper
    // filters to current tier + non-null lastQualityScore internally.
    const allConcepts = await getConceptsByCourse(ctx.course.id, tx);
    const currentTier = ctx.course.currentTier;
    const tierAdvancedTo = tierCheckRuns
      ? await maybeAdvanceTier(tx, ctx.course.id, currentTier, allConcepts)
      : null;
    const newCurrentTier = tierAdvancedTo ?? currentTier;

    // 5. Capture due snapshot for Wave N+1 — via tx so step-3's next_review_at
    //    writes are reflected. Parse-before-persist routes the raw
    //    `lastQualityScore: number | null` through the schema so any stored
    //    value outside [0,5] surfaces here, not as a downstream Zod failure.
    //    No limit: the snapshot carries every due concept.
    const dueConcepts = await getDueConceptsByCourse(ctx.course.id, now, undefined, tx);
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
    //    closing wave is plan-faithful. Wave N+1 snapshots the learner's
    //    current custom instructions (issue #236): a save during Wave N
    //    lands here, and Wave N's own snapshot never changes.
    const customInstructionsSnapshot = await getCourseOwnerCustomInstructionsInTx(
      ctx.course.id,
      tx,
    );
    const nextWaveNumber = ctx.wave.waveNumber + 1;
    const nextWave = await openWave(
      {
        courseId: ctx.course.id,
        waveNumber: nextWaveNumber,
        tier: newCurrentTier,
        frameworkSnapshot: ctx.wave.frameworkSnapshot as FrameworkJsonb,
        customInstructionsSnapshot,
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

    // 8. Bump total_xp by completionXp, inside the tx.
    await incrementCourseXpInTx(ctx.course.id, WAVE.completionXp, tx);

    // 9. Read the total back after the last XP write. The course-row lock from
    //    step 0 holds, so this is the value the transaction commits.
    const totalXp = await getCourseTotalXpInTx(ctx.course.id, tx);

    return {
      nextWaveId: nextWave.id,
      nextWaveNumber,
      completionXpAwarded: WAVE.completionXp,
      tierAdvancedTo,
      gradedSignals,
      totalXp,
    } as const;
  });
}
