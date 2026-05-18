import type { DbOrTx } from "@/db/client";
import { getAssessmentByWaveAndQuestionId } from "@/db/queries/assessments";
import { getConceptById } from "@/db/queries/concepts";
import { applyAssessmentGrading, type GradedSignal } from "./applyAssessmentGrading";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";

/**
 * Internal helper for `executeWaveMid` — graded comprehensionSignals batch.
 *
 * Split out of `executeWaveMid.ts` to keep both files under the ~200-line
 * ceiling. Not re-exported via the barrel; only `executeWaveMid` calls it.
 */

/** One row of the graded-signals output. Matches `ExecuteWaveMidResult.gradedSignals[]`. */
export interface GradedRow {
  readonly kind: GradedSignal["kind"];
  readonly questionId: string;
  readonly xpAwarded: number;
  readonly correct?: boolean;
  readonly qualityScore?: number;
}

/**
 * Inputs to `gradePriorAnswers`. The orchestrator builds the lookup maps once
 * and passes them in; this helper does only the per-signal dispatch.
 */
export interface GradePriorAnswersParams {
  readonly tx: DbOrTx;
  readonly waveId: string;
  /** The model-emitted signals to grade — may be empty. */
  readonly signals: NonNullable<WaveMidTurn["comprehensionSignals"]>;
  /** Gate: no open questionnaire ⇒ signals are advisory only (no row to update). */
  readonly hasOpenQuestionnaire: boolean;
  /** Question id → learner answer text (set if learner answered this turn). */
  readonly answerTextById: ReadonlyMap<string, string>;
  /** Question id → expected MC correct key letter (MC questions only). */
  readonly correctLetterById: ReadonlyMap<string, "A" | "B" | "C" | "D">;
}

/**
 * Resolve each comprehensionSignal to its assessment row, fetch the concept
 * tier, and apply grading. Defensive skips with stderr logs:
 *   - signal targets a question id we have no row for (model error)
 *   - signal targets a question the learner didn't answer this turn
 *
 * Returns the per-signal grading shape the orchestrator surfaces upstream.
 */
export async function gradePriorAnswers(
  params: GradePriorAnswersParams,
): Promise<readonly GradedRow[]> {
  if (!params.hasOpenQuestionnaire || params.signals.length === 0) return [];
  // Sequential loop (not Promise.all) — all writes hit the same transaction
  // handle; concurrency complicates error attribution without buying anything.
  // `reduce` would force functional purity but here we need the row -> concept
  // chain, so a for-of with a builder array is clearest.
  const accumulated: readonly GradedRow[] = await params.signals.reduce<
    Promise<readonly GradedRow[]>
  >(async (accP, sig) => {
    const acc = await accP;
    const row = await getAssessmentByWaveAndQuestionId(params.waveId, sig.questionId, params.tx);
    if (!row) {
      // Model referenced a questionId we don't have. Skip + log.
      process.stderr.write(
        `[executeWaveMid] no assessment row for wave=${params.waveId} questionId=${sig.questionId}; skipping\n`,
      );
      return acc;
    }
    const userAnswer = params.answerTextById.get(sig.questionId);
    if (userAnswer === undefined) {
      // Signal targets a question the learner didn't answer this turn — skip
      // to avoid corrupting the row with a verdict the learner didn't give.
      process.stderr.write(
        `[executeWaveMid] signal for questionId=${sig.questionId} but learner did not answer it; skipping\n`,
      );
      return acc;
    }
    // Concept tier drives XP. Tier is immutable post-insert (spec §3) so
    // reading via the singleton outside the tx is safe — getConceptById
    // doesn't take tx and we don't need write-after-read visibility here.
    const concept = await getConceptById(row.conceptId);
    // Build the GradedSignal applyAssessmentGrading expects. MC correctness
    // is mechanical: compare the learner's selected letter against the
    // open-questionnaire's `correct` key. Free-text trusts the model's verdict.
    const gradedSignal: GradedSignal =
      sig.kind === "mc-index"
        ? {
            kind: "mc-index",
            questionId: sig.questionId,
            correct: params.correctLetterById.get(sig.questionId) === userAnswer,
          }
        : {
            kind: "free-text",
            questionId: sig.questionId,
            verdict: sig.verdict,
            qualityScore: sig.qualityScore,
          };
    const applied = await applyAssessmentGrading({
      assessmentId: row.id,
      conceptTier: concept.tier,
      signal: gradedSignal,
      tx: params.tx,
      userAnswer,
    });
    const out: GradedRow =
      sig.kind === "mc-index"
        ? {
            kind: applied.kind,
            questionId: applied.questionId,
            xpAwarded: applied.xpAwarded,
            correct: params.correctLetterById.get(sig.questionId) === userAnswer,
          }
        : {
            kind: applied.kind,
            questionId: applied.questionId,
            xpAwarded: applied.xpAwarded,
            correct: sig.verdict === "correct",
            qualityScore: sig.qualityScore,
          };
    return [...acc, out];
  }, Promise.resolve([]));
  return accumulated;
}
