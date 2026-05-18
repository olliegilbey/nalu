import type { DbOrTx } from "@/db/client";
import { calculateMcXp, calculateXP } from "@/lib/scoring/xp";
import { updateAssessmentGrading } from "@/db/queries/assessments";

/**
 * Two grading signals the harness can receive per assessment row:
 *
 * - `mc-index`: mechanical correctness from comparing the learner's chosen
 *   index against the stored `correctIndex`. No LLM in the loop here.
 * - `free-text`: LLM-graded verdict + qualityScore for prose answers.
 *
 * Both produce one `applyAssessmentGrading` call: row updated + XP awarded.
 */
export type GradedSignal =
  | { readonly kind: "mc-index"; readonly questionId: string; readonly correct: boolean }
  | {
      readonly kind: "free-text";
      readonly questionId: string;
      readonly verdict: "correct" | "partial" | "incorrect";
      readonly qualityScore: number;
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
        // Mechanical MC: q=4 correct, q=1 incorrect (matches BASELINE convention).
        // Stored so the SM-2 close-step sees a quality value even when no LLM
        // judged the answer.
        qualityScore: params.signal.correct ? 4 : 1,
        xpAwarded: xp,
      },
      params.tx,
    );
    return { questionId: params.signal.questionId, xpAwarded: xp, kind: "mc-index" };
  }
  // Free-text path: LLM-graded verdict + qualityScore → tiered XP.
  const xp = calculateXP(params.conceptTier, params.signal.qualityScore);
  const isCorrect = params.signal.verdict === "correct";
  await updateAssessmentGrading(
    params.assessmentId,
    { isCorrect, qualityScore: params.signal.qualityScore, xpAwarded: xp },
    params.tx,
  );
  return { questionId: params.signal.questionId, xpAwarded: xp, kind: "free-text" };
}
