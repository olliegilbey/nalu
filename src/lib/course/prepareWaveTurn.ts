import { TRPCError } from "@trpc/server";
import { db } from "@/db/client";
import { appendWaveChatLog, getWaveByCourseAndNumber } from "@/db/queries/waves";
import { WAVE } from "@/lib/config/tuning";
import type { WaveChatLog, WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";
import { buildLearnerInput, type SubmitTurnPayload } from "./buildLearnerInput";
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
import { learnerEntryAlreadyAppended } from "./learnerEntryAlreadyAppended";
import { loadWaveContext, type LoadedWaveContext } from "./loadWaveContext";
import type { SubmitWaveTurnParams } from "./submitWaveTurn";

/** Everything submitWaveTurn/streamWaveTurn need to dispatch one turn. */
export interface PreparedWaveTurn {
  readonly dispatchCtx: LoadedWaveContext;
  readonly learnerInput: string;
  readonly turnsRemaining: number;
  readonly isCloseTurn: boolean;
  readonly payload: SubmitTurnPayload;
}

/**
 * Guards + idempotency + pre-LLM persistence for one learner turn
 * (spec §3.3 / §7.4). Extracted verbatim from submitWaveTurn so the tRPC
 * (blocking) and route-handler (streaming) transports share one gate.
 * Keep the bug_001 resume-awareness block intact — see its comments.
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
export async function prepareWaveTurn(params: SubmitWaveTurnParams): Promise<PreparedWaveTurn> {
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

  // Build the learner's chat_log entry up front — both the resume check and
  // the (conditional) append consume it.
  const learnerEntry: WaveChatLogEntry =
    params.payload.kind === "chat-text"
      ? { role: "user", kind: "text", content: params.payload.text }
      : {
          role: "user",
          kind: "answers",
          questionnaireId: params.payload.questionnaireId,
          responses: params.payload.answers.map((a) =>
            a.kind === "mc"
              ? { questionId: a.id, choice: a.selected }
              : { questionId: a.id, freetext: a.text },
          ),
        };

  // bug_001: resume-aware idempotency. The pre-LLM append below is a raw,
  // non-idempotent JSONB concat; a previous attempt whose LLM dispatch threw
  // leaves the learner entry orphaned as the trailing chat_log entry. Detect
  // that so the retry reuses it instead of double-appending — see
  // `learnerEntryAlreadyAppended` for the full rationale. The `chatLog` cast
  // is safe: `waveRowGuard` validated the shape (cf. `getWaveState.ts`).
  const fullChatLog = ctx.wave.chatLog as WaveChatLog;
  const isResume = learnerEntryAlreadyAppended(fullChatLog, learnerEntry);
  // On a resume, strip the trailing orphan so all derivations below (open
  // questionnaire, turnsRemaining) see wave state as it was *before* the
  // failed attempt — exactly what the original (non-retry) call computed.
  const chatLog: WaveChatLog = isResume ? fullChatLog.slice(0, -1) : fullChatLog;

  // (2) §7.4 mutual-exclusion guards. The four checks below are the entire
  // turn-acceptance gate; downstream code assumes them.
  // Open questionnaire is derived from chat_log here — loadWaveContext no
  // longer carries it. The find helper is a single linear scan; cheap.
  const openQuestionnaire = findOpenQuestionnaire(chatLog);
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
  // envelope. Turns consumed = user-role entries in chat_log. After this
  // turn's executeWaveMid persists its assistant entry + this fn's pre-LLM
  // user entry, consumed advances by exactly 1. WAVE.turnCount is the budget;
  // turnsRemaining = budget - (current + about-to-land). Clamp at 0 so a late
  // close doesn't go negative.
  // Counts the pre-failure user entries — `chatLog` already excludes a resume
  // orphan, so a retry computes the identical value the original call did.
  const consumed = chatLog.filter((e) => e.role === "user").length;
  const turnsRemaining = Math.max(0, WAVE.turnCount - (consumed + 1));
  const isCloseTurn = turnsRemaining === 0;

  // Dual-write (learner side): persist the learner's chat_log entry BEFORE
  // dispatching the LLM call. Mirrors scoping's pre-LLM persistence pattern
  // (`generateFramework.ts`, `submitBaseline.persist.ts`) — if the LLM
  // transport fails, the learner's submission survives in `waves.chat_log`
  // (the UI source of truth) even though `context_messages` (the LLM replay
  // log) only gains its `user_message` / `card_answer` rows on LLM success
  // inside executeTurn's atomic batch. The two stores intentionally diverge
  // on the failure path — see docs/ARCHITECTURE.md ("per-store atomicity").
  // No enclosing tx here (the executeWaveMid / executeWaveClose tx hasn't
  // started yet), so we write against the `db` singleton. bug_001: skip the
  // append on a resume — the orphan already represents this exact submission.
  if (!isResume) {
    await appendWaveChatLog(db, ctx.wave.id, learnerEntry);
  }

  // Render the learner-input envelope once; both mid + close consume the same shape.
  const learnerInput = buildLearnerInput(params.payload, openQuestionnaire);

  // bug_001: mid/close dispatch independently re-derive the open questionnaire
  // from `ctx.wave.chatLog`; on a resume the orphan would make them see Q as
  // answered (grading silently skipped). Hand them the orphan-stripped log.
  const dispatchCtx = isResume ? { ...ctx, wave: { ...ctx.wave, chatLog } } : ctx;

  return { dispatchCtx, learnerInput, turnsRemaining, isCloseTurn, payload: params.payload };
}
