import { BASELINE, PROGRESSION } from "@/lib/config/tuning";
import type { BaselineEvaluationItem, BaselineQuestion, McOptionKey } from "@/lib/prompts";
import type { LlmUsage } from "@/lib/types/llm";
import type { QualityScore } from "@/lib/types/spaced-repetition";
import type { BaselineAnswer, QuestionGrading } from "./gradeBaseline";

/** Quality score for a correct MC click (from `tuning.BASELINE`). */
export const MC_CORRECT_QUALITY: QualityScore = BASELINE.mcCorrectQuality;
/** Quality score for an incorrect MC click. */
export const MC_INCORRECT_QUALITY: QualityScore = BASELINE.mcIncorrectQuality;

/**
 * `LlmUsage` (= AI SDK `LanguageModelUsage`) requires detail sub-objects
 * even when no call was made. Zero-filled across the board — cache /
 * reasoning fields are `0` rather than `undefined` so the merge reads
 * cleanly downstream if a caller ever aggregates token counts.
 */
export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: {
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokenDetails: {
    textTokens: 0,
    reasoningTokens: 0,
  },
};

/**
 * One question's split decision: either mechanical MC grading (no LLM
 * needed) or an LLM-batch item. `qid` keeps the subsequent merge loop
 * from having to narrow the union at every access.
 */
export type QuestionSplit =
  | { readonly kind: "mechanical"; readonly qid: string; readonly grading: QuestionGrading }
  | { readonly kind: "llm"; readonly qid: string; readonly item: BaselineEvaluationItem };

/**
 * Deterministic MC grading (P-AC-04). A correct click maps to
 * `BASELINE.mcCorrectQuality`; an incorrect click to
 * `BASELINE.mcIncorrectQuality`. `isCorrect` follows from
 * `quality ≥ PROGRESSION.passingQualityScore`, which keeps the boundary
 * consistent with tier-advancement logic.
 */
export function gradeMc(question: BaselineQuestion, selected: McOptionKey): QuestionGrading {
  if (question.type !== "multiple_choice") {
    throw new Error(`gradeMc called with free_text question ${question.id}`);
  }
  const correct = selected === question.correct;
  const quality: QualityScore = correct ? MC_CORRECT_QUALITY : MC_INCORRECT_QUALITY;
  return {
    questionId: question.id,
    conceptName: question.conceptName,
    tier: question.tier,
    quality,
    isCorrect: quality >= PROGRESSION.passingQualityScore,
    rationale: correct
      ? "Selected the correct option."
      : `Selected ${selected}; correct option was ${question.correct}.`,
  };
}

/** Build the grader's input item from a free-text answer (native or escape). */
export function toEvaluationItem(
  question: BaselineQuestion,
  text: string,
  viaEscape: boolean,
): BaselineEvaluationItem {
  return {
    questionId: question.id,
    conceptName: question.conceptName,
    tier: question.tier,
    question: question.question,
    rubric: question.freetextRubric,
    learnerProse: text,
    viaEscape,
  };
}

/**
 * Classify one question: either mechanical MC (answer was a click on an
 * MC question) or LLM item (native free-text OR freetext-escape on an
 * MC question). A mismatch — an `mc` answer submitted against a
 * `free_text` question — is a UI bug and fails loud here.
 */
export function splitOne(question: BaselineQuestion, answer: BaselineAnswer): QuestionSplit {
  if (answer.kind === "mc") {
    if (question.type !== "multiple_choice") {
      throw new Error(`mc answer submitted for free_text question ${question.id}`);
    }
    return {
      kind: "mechanical",
      qid: question.id,
      grading: gradeMc(question, answer.selected),
    };
  }
  const viaEscape = question.type === "multiple_choice" && answer.fromEscape;
  return {
    kind: "llm",
    qid: question.id,
    item: toEvaluationItem(question, answer.text, viaEscape),
  };
}
