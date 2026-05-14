import { BASELINE, PROGRESSION } from "@/lib/config/tuning";
import type { McOptionKey } from "@/lib/prompts/questionnaire";
import type { LlmUsage } from "@/lib/types/llm";
import type { z } from "zod";
import type { baselineGradingSchema } from "@/lib/types/jsonb";

export type BaselineAnswer =
  | { readonly id: string; readonly kind: "mc"; readonly selected: McOptionKey }
  | {
      readonly id: string;
      readonly kind: "freetext";
      readonly text: string;
      readonly fromEscape: boolean;
    };

/** The new unified grading shape (camelCase, matches baselineGradingSchema). */
export type GradingEntry = z.infer<typeof baselineGradingSchema>;

/**
 * Wire shape for a single answered-question item handed to the batch grader.
 * Free-text and freetext-escape-on-MC answers share this shape; `viaEscape`
 * distinguishes them so the grader prompt can flag the contextual prefix
 * (P-AC-03). Lives here rather than `prompts/` because it's the lib-side
 * grader-input contract, not a prompt-text concern.
 */
export interface BaselineEvaluationItem {
  /** Question id from baseline generation (stable through grading). */
  readonly questionId: string;
  /** Concept name from the question — stored on the `assessments` row. */
  readonly conceptName: string;
  /** Tier of the question. Passed through so the grader sees the level. */
  readonly tier: number;
  /** Question text as shown to the learner. Trusted (our own output). */
  readonly question: string;
  /** Rubric from the question. Trusted. Source of truth for expectations. */
  readonly rubric: string;
  /** Learner's raw prose. Untrusted upstream; sanitisation runs in the prompt builder. */
  readonly learnerProse: string;
  /** True if the learner reached this grader via the freetext-escape affordance on an MC question. */
  readonly viaEscape: boolean;
}

/** Quality score for a correct MC click (from `tuning.BASELINE`). */
export const MC_CORRECT_QUALITY = BASELINE.mcCorrectQuality;
/** Quality score for an incorrect MC click. */
export const MC_INCORRECT_QUALITY = BASELINE.mcIncorrectQuality;

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
 * The shape of a baseline question as stored in the JSONB. We reference
 * this inline rather than importing the v4 schema types, to stay in v3-land.
 */
interface StoredQuestion {
  readonly id: string;
  readonly type: "multiple_choice" | "free_text";
  readonly prompt: string;
  readonly freetextRubric: string;
  readonly conceptName?: string;
  readonly tier?: number;
  /** Only on multiple_choice. */
  readonly options?: { A: string; B: string; C: string; D: string };
  readonly correct?: McOptionKey;
}

/**
 * One question's split decision: either mechanical MC grading (no LLM
 * needed) or an LLM-batch item. `qid` keeps the subsequent merge loop
 * from having to narrow the union at every access.
 */
export type QuestionSplit =
  | { readonly kind: "mechanical"; readonly qid: string; readonly grading: GradingEntry }
  | { readonly kind: "llm"; readonly qid: string; readonly item: BaselineEvaluationItem };

/**
 * Deterministic MC grading (P-AC-04). A correct click maps to
 * `BASELINE.mcCorrectQuality`; an incorrect click to
 * `BASELINE.mcIncorrectQuality`. `verdict` follows from
 * `quality >= PROGRESSION.passingQualityScore`, consistent with
 * tier-advancement logic. No "partial" verdict for mechanical MC.
 */
export function gradeMc(question: StoredQuestion, selected: McOptionKey): GradingEntry {
  if (question.type !== "multiple_choice") {
    throw new Error(`gradeMc called with free_text question ${question.id}`);
  }
  // Baseline questions are required to carry `conceptName` AND `tier` (see
  // baseline.ts superRefine). Silent defaults would corrupt SM-2 scheduling
  // (synthetic concept) and starting-tier placement (tier=0). Fail loud.
  if (question.conceptName === undefined) {
    throw new Error(`gradeMc: baseline question ${question.id} missing required conceptName`);
  }
  if (question.tier === undefined) {
    throw new Error(`gradeMc: baseline question ${question.id} missing required tier`);
  }
  const isCorrect = selected === question.correct;
  const qualityScore = isCorrect ? MC_CORRECT_QUALITY : MC_INCORRECT_QUALITY;
  const verdict: GradingEntry["verdict"] =
    qualityScore >= PROGRESSION.passingQualityScore ? "correct" : "incorrect";
  return {
    questionId: question.id,
    conceptName: question.conceptName,
    // Enriched server-side from the question's tier — the LLM-facing grading
    // schema doesn't emit conceptTier; persistence (`baselineGradingSchema`)
    // requires it so downstream consumers don't re-correlate against
    // `baseline.questions`.
    conceptTier: question.tier,
    verdict,
    qualityScore,
    rationale: isCorrect
      ? "Selected the correct option."
      : `Selected ${selected}; correct option was ${question.correct}.`,
  };
}

/** Build the grader's input item from a free-text answer (native or escape). */
export function toEvaluationItem(
  question: StoredQuestion,
  text: string,
  viaEscape: boolean,
): BaselineEvaluationItem {
  // Baseline questions are required to carry `conceptName` and `tier`
  // (see baseline.ts superRefine). Silent defaults of `question.id` / `0`
  // would mask an upstream contract violation as a degraded grading run
  // (mis-attributed concept; tier=0 confusing the grader prompt). Fail loud.
  if (question.conceptName === undefined) {
    throw new Error(
      `toEvaluationItem: baseline question ${question.id} missing required conceptName`,
    );
  }
  if (question.tier === undefined) {
    throw new Error(`toEvaluationItem: baseline question ${question.id} missing required tier`);
  }
  return {
    questionId: question.id,
    conceptName: question.conceptName,
    tier: question.tier,
    question: question.prompt,
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
export function splitOne(question: StoredQuestion, answer: BaselineAnswer): QuestionSplit {
  if (answer.kind === "mc") {
    if (question.type !== "multiple_choice") {
      throw new Error(`mc answer submitted for free_text question ${answer.id}`);
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
