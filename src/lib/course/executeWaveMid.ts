import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { appendWaveChatLog } from "@/db/queries/waves";
import { contextMessages } from "@/db/schema";
import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
import { waveMidTurnSchema, renderWaveTurnEnvelope } from "@/lib/prompts/waveTurn";
import type { WaveChatLog, WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";
import { type SubmitTurnPayload } from "./buildLearnerInput";
import type { GradedSignal } from "./applyAssessmentGrading";
import { buildWaveSeed } from "./buildWaveSeed";
import { findOpenQuestionnaire, buildMcCorrectKeyMap } from "./findOpenQuestionnaire";
import type { LoadedWaveContext } from "./loadWaveContext";
import { gradePriorAnswers } from "./executeWaveMid.grade";
import { insertNewQuestionnaire, type NewQuestionnaireProjection } from "./executeWaveMid.insert";

export type { NewQuestionnaireProjection };

/**
 * Result of one mid-Wave turn. The router projects this to the client-safe
 * shape; the discriminator `kind` lets `submitWaveTurn` return either
 * mid-turn or close-turn under one union.
 */
export interface ExecuteWaveMidResult {
  readonly kind: "mid-turn";
  /** Turns remaining AFTER this turn completes (echoed back to the caller). */
  readonly turnsRemaining: number;
  /** Teaching prose the learner sees this turn (`parsed.userMessage`). */
  readonly assistantContent: string;
  /** New questionnaire to drop, or null if the model emitted none this turn. */
  readonly newQuestionnaire: NewQuestionnaireProjection | null;
  /** Per-question grading results for the learner's prior answers. */
  readonly gradedSignals: readonly {
    readonly kind: GradedSignal["kind"];
    readonly questionId: string;
    readonly xpAwarded: number;
    readonly correct?: boolean;
    readonly qualityScore?: number;
  }[];
}

/**
 * Per-turn orchestration for a mid-Wave teaching turn (spec §3.3).
 *
 * Flow:
 *   1. Dispatch `executeTurn` against `waveMidTurnSchema`. The harness
 *      persists `user_message + assistant_response` at a freshly-allocated
 *      turn_index.
 *   2. Open a transaction. Look up the latest `assistant_response` row for
 *      the wave — its id is the canonical `questionnaireId` (matches
 *      `loadWaveContext`), and its turn_index is where new assessment rows align.
 *   3. Grade learner's prior answers (`parsed.comprehensionSignals`). Each
 *      signal maps to one assessment row via `(wave_id, question_id)`.
 *      Defensive skips: unknown question id, or learner didn't answer it.
 *   4. Insert N placeholder rows for `parsed.questionnaire` (if any),
 *      upserting new concepts at default SM-2 state.
 *   5. Return the client-safe projection with `correctEnc` for MC questions.
 *
 * Transaction commits atomically: either all gradings + inserts land or none.
 */
export async function executeWaveMid(
  ctx: LoadedWaveContext,
  learnerInput: string,
  turnsRemaining: number,
  payload: SubmitTurnPayload,
): Promise<ExecuteWaveMidResult> {
  // Resolve open questionnaire once for grading-time lookups (correctLetterMap)
  // and the gradePriorAnswers `hasOpenQuestionnaire` flag. Derived from
  // chat_log per the new contract — `loadWaveContext` no longer carries it.
  // `ctx.wave.chatLog` is `unknown` at the Drizzle JSONB boundary; runtime
  // shape is enforced upstream by `waveRowGuard`.
  const openQuestionnaire = findOpenQuestionnaire(ctx.wave.chatLog as WaveChatLog);

  // Wire-side schema selection mirrors generateBaseline: strong models honour
  // strict-mode and receive the schema via response_format; weak models get
  // it inline in the envelope.
  const modelName = process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);
  const schemaJson = toSchemaJsonString(waveMidTurnSchema, { name: "wave_mid_turn" });

  const { parsed } = await executeTurn({
    parent: { kind: "wave", id: ctx.wave.id },
    seed: buildWaveSeed(ctx.course, ctx.wave),
    userMessageContent: renderWaveTurnEnvelope({
      learnerInput,
      turnsRemaining,
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
    }),
    responseSchema: waveMidTurnSchema,
    responseSchemaName: "wave_mid_turn",
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "wave-mid",
    successSummary: (p) =>
      `signals=${p.comprehensionSignals?.length ?? 0} questionnaire=${p.questionnaire ? p.questionnaire.questions.length : 0}`,
  });

  // Lookup tables built once, pure functions of payload + openQuestionnaire.
  // Used inside the transaction for grading.
  const answerTextById = buildAnswerTextMap(payload);
  // Question id → expected MC correct key letter (for MC questions only).
  // Free-text questions are absent. The grading helper compares each signal's
  // questionId's correct letter against the learner's `answerTextById` selection.
  const correctLetterById: ReadonlyMap<string, "A" | "B" | "C" | "D"> = openQuestionnaire
    ? buildMcCorrectKeyMap(openQuestionnaire)
    : new Map();

  const result = await db.transaction(async (tx) => {
    // Find the assistant_response row just persisted by executeTurn. We need
    // BOTH its row id (used as the canonical `questionnaireId` so the
    // mid-turn projection and the `loadWaveContext` reconstruction agree —
    // see `loadWaveContext.ts:117`) and its turn_index (assessments align
    // to it: questionnaire posed on N → graded on N+1).
    const [assistantRow] = await tx
      .select({ id: contextMessages.id, turnIndex: contextMessages.turnIndex })
      .from(contextMessages)
      .where(
        and(
          eq(contextMessages.waveId, ctx.wave.id),
          eq(contextMessages.kind, "assistant_response"),
        ),
      )
      .orderBy(desc(contextMessages.turnIndex))
      .limit(1);
    if (!assistantRow) {
      // executeTurn always persists user+assistant on success — absence
      // means something silently skipped persistence. Fail loud.
      throw new Error(
        `executeWaveMid: no assistant_response row for wave ${ctx.wave.id} after executeTurn`,
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
    // context_messages row executeTurn persisted. Same tx, all-or-nothing.
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
