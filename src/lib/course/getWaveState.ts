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
 *   - `turnsRemaining`: count of landed Turns subtracted from
 *     `WAVE.turnCount`. A Turn lands when its reply is saved, so this counts
 *     user-role entries, minus a trailing one that has no reply yet.
 *   - `turnBudget`: `WAVE.turnCount`, the budget `prepareWaveTurn` enforces.
 *     It rides beside `turnsRemaining` so the progress strip reads both from
 *     the server and derives no turn count from the chat log (issue #80).
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
  /** Turns in this Wave: `WAVE.turnCount`, the budget the Harness enforces. */
  readonly turnBudget: number;
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
 *   4. `turnsRemaining` = `WAVE.turnCount - (landed Turn count)`.
 *
 * NOTE on `turnsRemaining`: it is derived from chat_log alone. A Turn lands
 * when its reply is saved: `persistWaveMidTurn` and `persistWaveClose` each
 * append an assistant entry after the learner's. `prepareWaveTurn` writes the
 * learner entry before the LLM call, so that write alone is not a landed
 * Turn. Counting landed Turns gives the value the LLM saw on its last
 * successful emission. Future cleanup (Tasks 12, 13) removes the
 * `context_messages` legacy that produced that count previously.
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

  // (4) Turns-remaining: count landed Turns. Both `kind: "text"` and
  // `kind: "answers"` mark a learner submission; assistant entries don't
  // decrement the budget. A Turn lands when its reply is saved: every mid and
  // close turn appends an assistant entry after the learner's. But
  // `prepareWaveTurn` saves the learner entry before the LLM call, so a
  // trailing user entry is a Turn still streaming, or one that failed and
  // waits for a retry (bug_001). It has not landed, so it does not count.
  // Otherwise a refetch would move the progress strip early (issue #80).
  // This matches `prepareWaveTurn`'s `consumed` only on an identical retry:
  // `learnerEntryAlreadyAppended` strips the entry before counting. A
  // different message counts the stranded entry as a spent Turn.
  const submitted = entries.filter((e) => e.role === "user").length;
  const replyPending = entries.at(-1)?.role === "user";
  const landed = replyPending ? submitted - 1 : submitted;
  const turnsRemaining = Math.max(0, WAVE.turnCount - landed);

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
    turnBudget: WAVE.turnCount,
    chatLog,
    totalXp: course.totalXp,
    // closeResult is always null on getWaveState — see WaveState TSDoc.
    closeResult: null,
  };
}
