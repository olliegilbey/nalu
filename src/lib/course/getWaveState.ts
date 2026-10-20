import { TRPCError } from "@trpc/server";
import { getCourseById, NotFoundError } from "@/db/queries/courses";
import { getWaveByCourseAndNumber } from "@/db/queries/waves";
import { WAVE } from "@/lib/config/tuning";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { redactWaveChatLog, type WaveChatLogEntryForClient } from "./redactWaveChatLog";

/**
 * Client-facing projection of a wave's state.
 *
 * Post-refactor (Phase C, plan Task 11): the wire shape is the typed JSONB
 * `waves.chat_log` projected through `redactWaveChatLog`. The previous
 * `messages` + `openQuestionnaire` envelope-style projection is GONE — there
 * is no more `loadWaveContext` reconstruction, no `context_messages` read,
 * and no per-row trimming. The chat scroll in the client renders from
 * `chatLog` directly. This mirrors scoping's `getState`, which ships the typed
 * JSONB store (`courses.clarification`, `courses.baseline`) through the same
 * per-question redaction (`redactQuestion`).
 *
 * Carries:
 *   - `status`: active vs closed — the UI gates the composer on this. DB
 *     stores `open` for active waves but the wire shape uses `active` for
 *     client-side clarity (plan §7.2 vocabulary).
 *   - `chatLog`: ordered, redacted projection of `waves.chat_log`. Each
 *     entry is `WaveChatLogEntryForClient`; MC `correct` keys are replaced
 *     by questionId-bound `correctEnc` blobs. The client folds these into
 *     its `ChatEntry[]` via `deriveWaveChatEntries`.
 *   - `turnsRemaining`: count of user-role entries subtracted from
 *     `WAVE.turnCount`. The chat_log is the single source of truth for
 *     "what has the learner submitted" so the count is a one-line filter.
 *   - `totalXp`: the course's `courses.total_xp`, from the course row the
 *     ownership check loads.
 *   - `closeResult`: always `null` here. The close result streams once, as
 *     the turn's `data-turn-result` part (spec §7.2); it is not a re-readable
 *     wave property. The field exists on the wire shape for client-side union
 *     stability so consumers can treat `WaveState` and the streamed close
 *     payload uniformly without conditional property access.
 *
 * No business logic — pure projection over the wave row.
 */

/** Full wave-state projection returned to the client. */
export interface WaveState {
  readonly courseId: string;
  /** Course topic — populates the wave header title. */
  readonly topic: string;
  readonly waveId: string;
  readonly waveNumber: number;
  readonly currentTier: number;
  readonly status: "active" | "closed";
  readonly turnsRemaining: number;
  readonly chatLog: readonly WaveChatLogEntryForClient[];
  /** Course XP after this request: `courses.total_xp`, never a delta. */
  readonly totalXp: number;
  /**
   * Always `null` on `getWaveState` — the close result streams once, as the
   * turn's `data-turn-result` part; it is not a re-readable wave property
   * (spec §7.2). The shape
   * below is a NARROWER SUBSET of `ExecuteWaveCloseResult` (omits `kind`,
   * `nextWaveId`, `gradedSignals`, `totalXp`) — the four fields a client typically
   * re-renders after close. The full close payload comes from that stream
   * part; this field exists as a documentation handle only.
   */
  readonly closeResult: null | {
    readonly closingMessage: string;
    readonly nextWaveNumber: number;
    readonly completionXpAwarded: number;
    readonly tierAdvancedTo: number | null;
  };
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
 *   1. Resolve `(courseId, waveNumber)` → wave row. NOT_FOUND if absent.
 *   2. Fetch the course row and check `userId` ownership. NOT_FOUND on a
 *      mismatch (the same code used for "no such wave" — we never disclose
 *      whether the resource exists under another user).
 *   3. Project `wave.chatLog` (validated by `waveRowGuard` on read) through
 *      `redactWaveChatLog`.
 *   4. `turnsRemaining` = `WAVE.turnCount - (user-role entry count)`.
 *
 * NOTE on `turnsRemaining`: post-rewrite this is now derived from chat_log
 * exclusively. The chat_log is dual-written everywhere a user submission
 * lands (prepareWaveTurn pre-LLM persist, persistWaveMidTurn assistant entry,
 * persistWaveClose summary entry), so the count matches the
 * envelope-derived value the LLM saw on its last emission. Future cleanup
 * (Tasks 12, 13) removes the `context_messages` legacy that produced that
 * count previously.
 */
export async function getWaveState(params: GetWaveStateParams): Promise<WaveState> {
  // (1) Resolve waveNumber → wave row. Use this resolver in both
  // `getWaveState` and `prepareWaveTurn` so the natural URL addressing scheme
  // (courseId, waveNumber) maps to row ids in one place.
  const wave = await getWaveByCourseAndNumber(params.courseId, params.waveNumber);
  if (!wave) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `wave ${params.waveNumber} not found for course ${params.courseId}`,
    });
  }

  // (2) Ownership check. `getCourseById` throws `NotFoundError` on a missing
  // row OR a userId mismatch (existence is not disclosed across owners). The
  // course row is retained — its `topic` populates the wave header title, and
  // its `totalXp` is the course total.
  const course = await getCourseById(params.courseId, params.userId).catch(
    (err: unknown): never => {
      if (err instanceof NotFoundError) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `wave ${params.waveNumber} not found for course ${params.courseId}`,
        });
      }
      throw err;
    },
  );

  // (3) chat_log is typed `unknown` on the Drizzle row (jsonb isn't
  // parameterised at the column type; `waveRowGuard` validated the array
  // shape on read). Cast at the boundary — same pattern used in
  // `persistWaveMidTurn.integration.test.ts` / `prepareWaveTurn.integration.test.ts`.
  // Task 17 schedules the proper fix at the schema layer.
  const entries = wave.chatLog as WaveChatLog;
  const chatLog = redactWaveChatLog(entries);

  // (4) Turns-remaining: count user-role entries. Both `kind: "text"` and
  // `kind: "answers"` mark a learner submission landing; assistant entries
  // don't decrement the budget. Mirrors `prepareWaveTurn`'s `consumed` count
  // by construction (chat_log is dual-written on every learner submit).
  const consumed = entries.filter((e) => e.role === "user").length;
  const turnsRemaining = Math.max(0, WAVE.turnCount - consumed);

  // Map DB status → wire status: DB column uses "open" for an in-progress
  // wave; the wire shape (plan §7.2) calls this "active". Closed stays closed.
  const wireStatus: "active" | "closed" = wave.status === "closed" ? "closed" : "active";

  return {
    courseId: wave.courseId,
    topic: course.topic,
    waveId: wave.id,
    waveNumber: wave.waveNumber,
    currentTier: wave.tier,
    status: wireStatus,
    turnsRemaining,
    chatLog,
    totalXp: course.totalXp,
    // closeResult is always null on getWaveState — see WaveState TSDoc.
    closeResult: null,
  };
}
