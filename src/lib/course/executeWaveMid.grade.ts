import type { DbOrTx } from "@/db/client";
import { getAssessmentByWaveAndQuestionId } from "@/db/queries/assessments";
import { getConceptById } from "@/db/queries/concepts";
import { applyAssessmentGrading, type GradedSignal } from "./applyAssessmentGrading";
import { namespaceQuestionId } from "./namespaceQuestionId";
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
  /**
   * Id of the open questionnaire being graded (its `assistant_response` row id),
   * or null when none is open. Used to re-derive the namespaced `question_id`
   * the insert path stored (`namespaceQuestionId`) — the model emits the RAW
   * `q.id` in its signals because that is what it sees in the prompt, so the
   * stored-row lookup must re-apply the same namespace prefix. Doubles as the
   * `hasOpenQuestionnaire` gate: null ⇒ signals are advisory only (no row to
   * update).
   */
  readonly openQuestionnaireId: string | null;
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
  if (params.openQuestionnaireId === null || params.signals.length === 0) return [];
  // Narrow for the closure below — `openQuestionnaireId` is non-null past the gate.
  const questionnaireId = params.openQuestionnaireId;
  // Sequential async-reduce — writes hit the same tx handle; concurrency
  // complicates error attribution without buying anything. Reduce (rather
  // than for-of with a push-builder) keeps `eslint-plugin-functional` happy
  // without an escape-hatch comment.
  const accumulated: readonly GradedRow[] = await params.signals.reduce<
    Promise<readonly GradedRow[]>
  >(async (accP, sig) => {
    const acc = await accP;
    // The model emits the RAW `q.id` it saw in the prompt; the stored row keys
    // on the namespaced form (`namespaceQuestionId`), so re-derive it for the
    // lookup. The raw id is still what we surface to the client below.
    const storedQuestionId = namespaceQuestionId(questionnaireId, sig.questionId);
    const row = await getAssessmentByWaveAndQuestionId(params.waveId, storedQuestionId, params.tx);
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
    // Concept tier drives XP. Thread the tx so a concept upserted earlier in
    // the same transaction is visible — the safer default. Today the only
    // concept writes happen later (in `insertNewQuestionnaire`), but threading
    // here removes a footgun if step order is ever rearranged.
    const concept = await getConceptById(row.conceptId, params.tx);
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
