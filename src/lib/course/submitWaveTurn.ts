import { TRPCError } from "@trpc/server";
import { getMessagesForWave } from "@/db/queries/contextMessages";
import { getWaveByCourseAndNumber } from "@/db/queries/waves";
import { WAVE } from "@/lib/config/tuning";
import { buildLearnerInput, type SubmitTurnPayload } from "./buildLearnerInput";
import { loadWaveContext } from "./loadWaveContext";
import { executeWaveMid, type ExecuteWaveMidResult } from "./executeWaveMid";
import { executeWaveClose, type ExecuteWaveCloseResult } from "./executeWaveClose";

/**
 * Entry point for one learner turn against an open Wave (spec §3.3 / §7.4).
 *
 * Responsibilities (this file):
 *   1. Resolve `(courseId, waveNumber)` → wave; load context + open questionnaire.
 *   2. Enforce §7.4 mutual exclusion: chat-text vs questionnaire-answers must
 *      match the wave's current open-questionnaire state, and a
 *      questionnaire-answers payload must address the right questionnaire id
 *      with the right answer count.
 *   3. Compute `turnsRemaining` (the value the LLM will see in this turn's
 *      envelope) from the persisted row count. Dispatch to mid-turn or close-turn.
 *
 * All persistence + LLM dispatch is delegated to `executeWaveMid` /
 * `executeWaveClose` — this entry point is just guards + routing.
 */

/** Input to {@link submitWaveTurn}. */
export interface SubmitWaveTurnParams {
  readonly userId: string;
  readonly courseId: string;
  readonly waveNumber: number;
  readonly payload: SubmitTurnPayload;
}

/**
 * Discriminated union returned to the router. `kind` lets the client branch
 * (mid-turn: render new questionnaire + grading toast; close-turn: animate
 * the close, redirect to Wave N+1 via `nextWaveId`).
 */
export type SubmitWaveTurnResult = ExecuteWaveMidResult | ExecuteWaveCloseResult;

/**
 * Process one learner submission against an open Wave.
 *
 * Throws TRPCError on:
 *   - NOT_FOUND: wave doesn't exist for this (courseId, waveNumber).
 *   - PRECONDITION_FAILED: §7.4 mutual-exclusion violations
 *     (chat-text while questionnaire is open; questionnaire-answers with no
 *     open questionnaire; stale questionnaireId; answer count mismatch).
 *   - PRECONDITION_FAILED: wave is already closed (no more turns accepted).
 *
 * Ownership is enforced via `loadWaveContext` → `getCourseById`, which surfaces
 * cross-user reads as NOT_FOUND (info-leak-safe).
 */
export async function submitWaveTurn(params: SubmitWaveTurnParams): Promise<SubmitWaveTurnResult> {
  // (1) Resolve waveNumber → wave row id. The natural URL addressing scheme
  // is (courseId, waveNumber); this resolver maps it once, here.
  const wave = await getWaveByCourseAndNumber(params.courseId, params.waveNumber);
  if (!wave) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `wave ${params.waveNumber} not found for course ${params.courseId}`,
    });
  }

  // Load context (ownership, course/wave containment, open questionnaire).
  const ctx = await loadWaveContext({
    userId: params.userId,
    courseId: params.courseId,
    waveId: wave.id,
  });

  // Closed waves do not accept further turns. The router would otherwise
  // happily run executeTurn against an already-closed wave; fail loud at the
  // entry boundary so the client gets a clean error code.
  if (ctx.wave.status !== "open") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `wave ${ctx.wave.id} is not open (status='${ctx.wave.status}')`,
    });
  }

  // (2) §7.4 mutual-exclusion guards. The four checks below are the entire
  // turn-acceptance gate; downstream code assumes them.
  const { openQuestionnaire } = ctx;
  if (params.payload.kind === "chat-text" && openQuestionnaire !== null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "chat-text rejected: an open questionnaire exists",
    });
  }
  if (params.payload.kind === "questionnaire-answers" && openQuestionnaire === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "no open questionnaire",
    });
  }
  if (
    params.payload.kind === "questionnaire-answers" &&
    openQuestionnaire !== null &&
    params.payload.questionnaireId !== openQuestionnaire.questionnaireId
  ) {
    // Stale id: the learner's tab has an old questionnaire (e.g. another tab
    // already answered it). Refuse before any LLM call — the model would see
    // an envelope that doesn't match the persisted context.
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "stale questionnaireId",
    });
  }
  if (
    params.payload.kind === "questionnaire-answers" &&
    openQuestionnaire !== null &&
    params.payload.answers.length !== openQuestionnaire.questions.length
  ) {
    // The learner must answer every question. The composer enforces this in
    // the UI; this server-side guard catches direct API misuse.
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "answer count mismatch",
    });
  }

  // (3) Compute turnsRemaining = the value the LLM will see in THIS turn's
  // envelope. After this turn's user_message/card_answer rows land, total
  // consumed = current + 1. WAVE.turnCount is the budget; subtract to get the
  // remaining count the LLM sees. clamp at 0 so a late close doesn't go negative.
  const rows = await getMessagesForWave(ctx.wave.id);
  const consumed = rows.filter((r) => r.kind === "user_message" || r.kind === "card_answer").length;
  const turnsRemaining = Math.max(0, WAVE.turnCount - (consumed + 1));
  const isCloseTurn = turnsRemaining === 0;

  // Render the learner-input envelope once; both mid + close consume the same shape.
  const learnerInput = buildLearnerInput(params.payload, openQuestionnaire);

  // Dispatch. Mid-turn needs the payload (used to resolve learner answers to
  // assessment rows during grading); close-turn does not (no new grading occurs
  // server-side past what was already persisted, though final grading runs against
  // the wave-close LLM emission).
  if (isCloseTurn) {
    return executeWaveClose(ctx, learnerInput);
  }
  return executeWaveMid(ctx, learnerInput, turnsRemaining, params.payload);
}
