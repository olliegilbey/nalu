import { TRPCError } from "@trpc/server";
import { getMessagesForWave } from "@/db/queries/contextMessages";
import { getWaveByCourseAndNumber } from "@/db/queries/waves";
import { WAVE } from "@/lib/config/tuning";
import type { ContextMessage } from "@/db/schema";
import { loadWaveContext } from "./loadWaveContext";
import { redactQuestionnaire, type OpenQuestionnaireForClient } from "./redactQuestionnaire";

/**
 * Client-facing projection of a wave's state.
 *
 * Carries:
 *   - `status`: open vs closed — the UI uses this to gate the composer.
 *   - `renderedMessages`: flat (turn_index, seq)-ordered context_messages,
 *     trimmed to the fields the chat scroll renders. The client passes these
 *     to `deriveWaveTurns` (Task 15) which folds them into a `Turn[]`.
 *   - `openQuestionnaire`: redacted shape (no plaintext `correct`); null
 *     when nothing is open.
 *   - `turnsRemaining`: pre-submission count. After the learner posts one
 *     reply, the BACK-END's response carries the post-submission value; this
 *     state's value reflects what the LLM saw on its LAST emission. Used by
 *     the UI to show a "n turns left" hint without round-tripping.
 *
 * No business logic — pure projection over `loadWaveContext` + the message log.
 */

/** Trimmed `context_messages` row for the client. */
export interface RenderedMessage {
  readonly id: string;
  readonly turnIndex: number;
  readonly seq: number;
  readonly kind: ContextMessage["kind"];
  readonly role: ContextMessage["role"];
  readonly content: string;
}

/** Full wave-state projection returned to the client. */
export interface WaveState {
  readonly courseId: string;
  readonly waveId: string;
  readonly waveNumber: number;
  readonly tier: number;
  readonly status: "open" | "closed";
  readonly turnsRemaining: number;
  readonly renderedMessages: readonly RenderedMessage[];
  readonly openQuestionnaire: OpenQuestionnaireForClient | null;
}

/** Input to {@link getWaveState}. `userId` enforces row-level ownership. */
export interface GetWaveStateParams {
  readonly userId: string;
  readonly courseId: string;
  readonly waveNumber: number;
}

/**
 * Load the full state for one Wave by its ordinal `waveNumber`.
 *
 * Resolution chain:
 *   1. Resolve `(courseId, waveNumber)` → wave row id. NOT_FOUND if absent.
 *   2. Delegate to `loadWaveContext` for ownership + open-questionnaire
 *      reconstruction (it cross-checks course ownership).
 *   3. Fetch the (turn_index, seq)-ordered message log; trim each row.
 *   4. Count consumed user-turn rows. `turnsRemaining` = the value the LLM
 *      saw on its last emission = `max(0, WAVE.turnCount - consumed)`.
 *
 * NOTE on `turnsRemaining`: this state reflects what the LLM emitted LAST.
 * `submitWaveTurn`'s post-submission value uses `consumed + 1` (after the
 * about-to-land turn). The two values differ by 1 by design.
 */
export async function getWaveState(params: GetWaveStateParams): Promise<WaveState> {
  // (1) Resolve waveNumber → wave row id. Use this resolver in both
  // `getWaveState` and `submitWaveTurn` so the natural URL addressing scheme
  // (courseId, waveNumber) maps to row ids in one place.
  const wave = await getWaveByCourseAndNumber(params.courseId, params.waveNumber);
  if (!wave) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `wave ${params.waveNumber} not found for course ${params.courseId}`,
    });
  }

  // (2) loadWaveContext enforces course ownership + cross-course containment
  // and reconstructs the latest unanswered questionnaire if one exists.
  const ctx = await loadWaveContext({
    userId: params.userId,
    courseId: params.courseId,
    waveId: wave.id,
  });

  // (3) Fetch full message log. Trimmed to the client-facing fields so the
  // wire shape doesn't leak DB-internal columns (createdAt, FKs, etc.).
  const rows = await getMessagesForWave(wave.id);
  const renderedMessages: readonly RenderedMessage[] = rows.map((r) => ({
    id: r.id,
    turnIndex: r.turnIndex,
    seq: r.seq,
    kind: r.kind as ContextMessage["kind"],
    role: r.role as ContextMessage["role"],
    content: r.content,
  }));

  // (4) Turns-remaining: count rows that mark a learner turn landing. Both
  // `user_message` (chat-text branch) and `card_answer` (questionnaire-answers
  // branch) advance the count by 1; harness rows / retry exhaust do not. This
  // matches `submitWaveTurn`'s `consumed` calculation exactly.
  const consumed = rows.filter((r) => r.kind === "user_message" || r.kind === "card_answer").length;
  const turnsRemaining = Math.max(0, WAVE.turnCount - consumed);

  // Open questionnaire → redacted projection (drops `correct`, adds correctEnc).
  // null when no open questionnaire exists (e.g. closed wave, or learner just
  // replied to the last one).
  const openQuestionnaire = ctx.openQuestionnaire
    ? redactQuestionnaire(ctx.openQuestionnaire)
    : null;

  return {
    courseId: ctx.course.id,
    waveId: ctx.wave.id,
    waveNumber: ctx.wave.waveNumber,
    tier: ctx.wave.tier,
    status: ctx.wave.status as "open" | "closed",
    turnsRemaining,
    renderedMessages,
    openQuestionnaire,
  };
}
