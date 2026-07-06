import type { SubmitTurnPayload } from "./buildLearnerInput";
import { prepareWaveTurn } from "./prepareWaveTurn";
import { executeWaveMid, type ExecuteWaveMidResult } from "./executeWaveMid";
import { executeWaveClose, type ExecuteWaveCloseResult } from "./executeWaveClose";

/**
 * Entry point for one learner turn against an open Wave (spec §3.3 / §7.4),
 * blocking transport (tRPC `wave.submitTurn`). All guards, idempotency, and
 * pre-LLM persistence live in `prepareWaveTurn` — shared with the streaming
 * transport (`streamWaveTurn`) so the two can never drift on turn acceptance.
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
 * Process one learner submission against an open Wave. Guards throw
 * TRPCError (NOT_FOUND / PRECONDITION_FAILED) — see `prepareWaveTurn`.
 */
export async function submitWaveTurn(params: SubmitWaveTurnParams): Promise<SubmitWaveTurnResult> {
  const prep = await prepareWaveTurn(params);
  return prep.isCloseTurn
    ? executeWaveClose(prep.dispatchCtx, prep.learnerInput)
    : executeWaveMid(prep.dispatchCtx, prep.learnerInput, prep.turnsRemaining, prep.payload);
}
