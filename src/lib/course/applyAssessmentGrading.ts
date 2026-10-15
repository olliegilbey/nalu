import type { DbOrTx } from "@/db/client";
import { calculateMcXp, calculateXP } from "@/lib/scoring/xp";
import { updateAssessmentGrading } from "@/db/queries/assessments.grade";
import { BASELINE } from "@/lib/config/tuning";
import type { QualityScore } from "@/lib/types/spaced-repetition";
import { verdictForQualityScore } from "@/lib/scoring/verdictBand";

/**
 * Two grading signals the harness can receive per assessment row:
 *
 * - `mc-index`: mechanical correctness from comparing the learner's chosen
 *   index against the stored `correctIndex`. No LLM in the loop here.
 * - `free-text`: an LLM-graded prose answer. Its `qualityScore` drives XP
 *   and correctness; its `verdict` is advisory (issue #198).
 *
 * Both produce one `applyAssessmentGrading` call: row updated + XP awarded.
 */
export type GradedSignal =
  | { readonly kind: "mc-index"; readonly questionId: string; readonly correct: boolean }
  | {
      readonly kind: "free-text";
      readonly questionId: string;
      // Unread since issue #198: correctness derives from `qualityScore`.
      // Dropping it, and its callers, is issue #213.
      readonly verdict: "correct" | "partial" | "incorrect";
      // `QualityScore` (not bare `number`): the value originates at the LLM
      // trust boundary via `qualityScoreSchema` and flows straight into the
      // `QualityScore`-typed `updateAssessmentGrading` patch — keep the domain
      // type intact end-to-end.
      readonly qualityScore: QualityScore;
    };

/** Inputs to `applyAssessmentGrading`. */
export interface ApplyAssessmentGradingParams {
  /** Assessment row id (already inserted at probe time). */
  readonly assessmentId: string;
  /** Tier of the concept being assessed — drives `calculateXP` / `calculateMcXp`. */
  readonly conceptTier: number;
  /** Either an MC-index correctness or a free-text LLM grading. */
  readonly signal: GradedSignal;
  /** Caller's transaction handle so the assessment update is atomic with siblings. */
  readonly tx: DbOrTx;
  /**
   * Optional learner answer text. When set, replaces the placeholder
   * `userAnswer = ""` written by `insertOpenAssessments` at probe time.
   * Omit when the row already holds the real answer.
   */
  readonly userAnswer?: string;
}

/** Returned to the caller so it can sum XP and tag turn payloads per question. */
export interface AppliedGrading {
  readonly questionId: string;
  readonly xpAwarded: number;
  readonly kind: GradedSignal["kind"];
}

/**
 * Per-question side effect: update assessment row, award XP. NO SM-2 touch —
 * concept mastery is decided holistically at Wave close via `conceptUpdates[]`
 * (see `applySm2Update`). This split exists because XP awards happen
 * per-probe but SM-2 reads/writes must batch at Wave close to honour the
 * "review injection at Wave boundaries only" rule (spec §3 decisions).
 */
export async function applyAssessmentGrading(
  params: ApplyAssessmentGradingParams,
): Promise<AppliedGrading> {
  if (params.signal.kind === "mc-index") {
    // MC path: deterministic XP from tier + correctness; no LLM quality score.
    const xp = calculateMcXp(params.conceptTier, params.signal.correct);
    await updateAssessmentGrading(
      params.assessmentId,
      {
        isCorrect: params.signal.correct,
        // Mechanical MC quality from the same tunables the baseline path
        // reads, so a tuning change moves both paths together. Stored so the
        // SM-2 close-step sees a quality value even when no LLM judged the
        // answer.
        qualityScore: params.signal.correct
          ? BASELINE.mcCorrectQuality
          : BASELINE.mcIncorrectQuality,
        xpAwarded: xp,
        // Forward the learner's text when the caller knows it (mid-turn flow);
        // omit otherwise so the existing user_answer column is left untouched.
        // Conditional spread keeps the call site flat and the type narrow.
        ...(params.userAnswer !== undefined ? { userAnswer: params.userAnswer } : {}),
      },
      params.tx,
    );
    return { questionId: params.signal.questionId, xpAwarded: xp, kind: "mc-index" };
  }
  // Free-text path: the LLM's qualityScore drives tiered XP and correctness.
  const xp = calculateXP(params.conceptTier, params.signal.qualityScore);
  // Correctness follows the score, not the model's verdict (issue #198). The
  // score sets XP, so a row can no longer say "correct" and earn 0 XP. Only
  // the "correct" band counts; a partial answer stays incorrect. The verdict
  // is now advisory: the flat tool wire still asks for it, because changing
  // that prompt-engineered wire needs a live A/B (`waveTurnTools.ts`).
  const isCorrect = verdictForQualityScore(params.signal.qualityScore) === "correct";
  await updateAssessmentGrading(
    params.assessmentId,
    {
      isCorrect,
      qualityScore: params.signal.qualityScore,
      xpAwarded: xp,
      ...(params.userAnswer !== undefined ? { userAnswer: params.userAnswer } : {}),
    },
    params.tx,
  );
  return { questionId: params.signal.questionId, xpAwarded: xp, kind: "free-text" };
}
