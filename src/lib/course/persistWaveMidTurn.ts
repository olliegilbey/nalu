import { db } from "@/db/client";
import { appendWaveChatLog } from "@/db/queries/waves.writes";
import { getLatestAssistantResponseForWaveInTx } from "@/db/queries/contextMessages";
import { lockCourseRowInTx } from "@/db/queries/courses.tx";
import type { WaveChatLog, WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";
import type { McOptionKey } from "@/lib/types/mcOptionKey";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";
import { findOpenQuestionnaire, buildMcCorrectKeyMap } from "./findOpenQuestionnaire";
import type { LoadedWaveContext } from "./loadWaveContext";
import { gradePriorAnswers, type GradedRow } from "./persistWaveMidTurn.grade";
import {
  insertNewQuestionnaire,
  type NewQuestionnaireProjection,
} from "./persistWaveMidTurn.insert";

/**
 * Result of one mid-Wave turn, streamed to the client as the
 * `data-turn-result` part. The discriminator `kind` puts mid-turn and
 * close-turn results under one union (`WaveTurnResultData`).
 */
export interface PersistWaveMidTurnResult {
  readonly kind: "mid-turn";
  /** Turns remaining AFTER this turn completes (echoed back to the caller). */
  readonly turnsRemaining: number;
  /** Teaching prose the learner sees this turn (`parsed.userMessage`). */
  readonly assistantContent: string;
  /** New questionnaire to drop, or null if the model emitted none this turn. */
  readonly newQuestionnaire: NewQuestionnaireProjection | null;
  /** Per-question grading results for the learner's prior answers. */
  readonly gradedSignals: readonly GradedRow[];
}

/**
 * Post-LLM persistence for one mid-Wave turn: lock the course row, grade
 * prior answers (each adds its XP to `courses.total_xp`), insert the new
 * questionnaire, dual-write the assistant chat_log entry — one transaction.
 * Runs after `streamWaveTurn`'s tool loop has committed the turn's
 * context_messages rows.
 */
export async function persistWaveMidTurn(params: {
  readonly ctx: LoadedWaveContext;
  readonly parsed: WaveMidTurn;
  readonly payload: SubmitTurnPayload;
  readonly turnsRemaining: number;
}): Promise<PersistWaveMidTurnResult> {
  const { ctx, parsed, payload, turnsRemaining } = params;

  // Resolve open questionnaire once for grading-time lookups (correctLetterMap)
  // and the gradePriorAnswers `hasOpenQuestionnaire` flag. Derived from
  // chat_log per the new contract — `loadWaveContext` no longer carries it.
  // `ctx.wave.chatLog` is `unknown` at the Drizzle JSONB boundary; runtime
  // shape is enforced upstream by `waveRowGuard`.
  const openQuestionnaire = findOpenQuestionnaire(ctx.wave.chatLog as WaveChatLog);

  // Lookup tables built once, pure functions of payload + openQuestionnaire.
  // Used inside the transaction for grading.
  const answerTextById = buildAnswerTextMap(payload);
  // Question id → expected MC correct key letter (for MC questions only).
  // Free-text questions are absent. The grading helper compares each signal's
  // questionId's correct letter against the learner's `answerTextById` selection.
  const correctLetterById: ReadonlyMap<string, McOptionKey> = openQuestionnaire
    ? buildMcCorrectKeyMap(openQuestionnaire)
    : new Map();

  const result = await db.transaction(async (tx) => {
    // Lock the course row first: grading below bumps `courses.total_xp`, and
    // a concurrent Wave close must queue here, not hold the Wave row we write
    // last (lock order: `src/db/queries/CLAUDE.md`).
    await lockCourseRowInTx(ctx.course.id, tx);

    // Find the assistant_response row the turn runner just persisted. We need
    // BOTH its row id (used as the canonical `questionnaireId` so the
    // mid-turn projection and the `loadWaveContext` reconstruction agree —
    // see `loadWaveContext.ts:117`) and its turn_index (assessments align
    // to it: questionnaire posed on N → graded on N+1).
    const assistantRow = await getLatestAssistantResponseForWaveInTx(ctx.wave.id, tx);
    if (!assistantRow) {
      // The turn runner always persists user+assistant on success — absence
      // means something silently skipped persistence. Fail loud.
      throw new Error(
        `persistWaveMidTurn: no assistant_response row for wave ${ctx.wave.id} after the turn`,
      );
    }

    const graded = await gradePriorAnswers({
      tx,
      waveId: ctx.wave.id,
      signals: parsed.comprehensionSignals ?? [],
      // The open questionnaire's id namespaces the stored `question_id` lookup
      // (`namespaceQuestionId`) and gates grading (null ⇒ advisory only).
      openQuestionnaireId: openQuestionnaire?.questionnaireId ?? null,
      answerTextById,
      correctLetterById,
    });

    const newQuestionnaire = parsed.questionnaire
      ? await insertNewQuestionnaire({
          tx,
          courseId: ctx.course.id,
          waveId: ctx.wave.id,
          assistantMessageId: assistantRow.id,
          assistantTurnIndex: assistantRow.turnIndex,
          questionnaire: parsed.questionnaire,
          waveTier: ctx.wave.tier,
        })
      : null;

    // Dual-write: assistant emission lands on chat_log alongside the
    // context_messages row the turn runner persisted. Same tx, all-or-nothing.
    // `questionnaireId` reuses `assistantRow.id` so emit + reload agree.
    const chatLogEntry: WaveChatLogEntry = parsed.questionnaire
      ? {
          role: "assistant",
          kind: "text_with_questionnaire",
          questionnaireId: assistantRow.id,
          content: parsed.userMessage,
          questions: parsed.questionnaire.questions,
        }
      : { role: "assistant", kind: "text", content: parsed.userMessage };
    await appendWaveChatLog(tx, ctx.wave.id, chatLogEntry);

    return { graded, newQuestionnaire };
  });

  return {
    kind: "mid-turn",
    turnsRemaining,
    assistantContent: parsed.userMessage,
    newQuestionnaire: result.newQuestionnaire,
    gradedSignals: result.graded,
  };
}

// ---------------------------------------------------------------------------
// Pure lookup-map builder (kept here because it's used by the grading path
// and small enough to inline).
// ---------------------------------------------------------------------------

/** Question id → learner answer text (MC: selected key letter; free-text: prose). */
function buildAnswerTextMap(payload: SubmitTurnPayload): ReadonlyMap<string, string> {
  if (payload.kind === "chat-text") return new Map();
  return new Map(
    payload.answers.map((a) => [a.id, a.kind === "mc" ? a.selected : a.text] as const),
  );
}
