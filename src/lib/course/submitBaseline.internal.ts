import { BASELINE, PROGRESSION } from "@/lib/config/tuning";
import { typedMcGradingRule } from "@/lib/prompts/questionnaire";
import type { McOptionKey, McOptions } from "@/lib/types/mcOptionKey";
import type { z } from "zod";
import type { baselineGradingSchema } from "@/lib/types/jsonb";
import type { QuestionnaireAnswer } from "@/lib/types/questionnaireAnswer";

/** The new unified grading shape (camelCase, matches baselineGradingSchema). */
export type GradingEntry = z.infer<typeof baselineGradingSchema>;

/**
 * Wire shape for a single answered-question item handed to the batch grader.
 * Free-text and freetext-escape-on-MC answers share this shape; `viaEscape`
 * distinguishes them so the grader prompt can flag the contextual prefix.
 * Lives here rather than `prompts/` because it's the lib-side
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
  readonly options?: McOptions;
  readonly correct?: McOptionKey;
}

/**
 * A baseline question's tier, or a loud throw. baseline.ts's superRefine
 * requires every question to carry one, and placement, XP and the grader
 * all read it. A silent default (tier 0) would corrupt all three.
 */
export function requireQuestionTier(question: {
  readonly id: string;
  readonly tier?: number | undefined;
}): number {
  if (question.tier === undefined) {
    throw new Error(`baseline question ${question.id} missing required tier`);
  }
  return question.tier;
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
 * Deterministic MC grading. A correct click maps to
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
  // baseline.ts superRefine). A silent default concept would corrupt SM-2
  // scheduling (synthetic concept). Fail loud.
  if (question.conceptName === undefined) {
    throw new Error(`gradeMc: baseline question ${question.id} missing required conceptName`);
  }
  const tier = requireQuestionTier(question);
  const isCorrect = selected === question.correct;
  const qualityScore = isCorrect ? MC_CORRECT_QUALITY : MC_INCORRECT_QUALITY;
  const verdict: GradingEntry["verdict"] =
    qualityScore >= PROGRESSION.passingQualityScore ? "correct" : "incorrect";
  return {
    questionId: question.id,
    conceptName: question.conceptName,
    // MC is graded mechanically — the LLM never sees this answer. Per the
    // LLM-XP boundary, the server uses the stored `question.tier` as the
    // authoritative source. (The wire schema does emit `conceptTier` for
    // free-text entries; that path is validated server-side in
    // `scoreBaseline` against the framework's `baselineScopeTiers`.)
    conceptTier: tier,
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
  // (see baseline.ts superRefine). A silent default of `question.id` would
  // mask an upstream contract violation as a degraded grading run
  // (mis-attributed concept). Fail loud.
  if (question.conceptName === undefined) {
    throw new Error(
      `toEvaluationItem: baseline question ${question.id} missing required conceptName`,
    );
  }
  return {
    questionId: question.id,
    conceptName: question.conceptName,
    tier: requireQuestionTier(question),
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
export function splitOne(question: StoredQuestion, answer: QuestionnaireAnswer): QuestionSplit {
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

/**
 * The close turn's learner input: the answers, plus the mechanical MC
 * gradings so the model does not re-grade clicks. A typed answer to an MC
 * question also carries `mcAnswerKey` (issue #149): the options, the correct
 * key and the rule to grade against it. The MC rubric is unchecked, so the
 * grader cannot rely on it. The caller's envelope XML-escapes the whole JSON.
 */
export function buildScopingCloseLearnerInput(params: {
  readonly questions: readonly StoredQuestion[];
  readonly answers: readonly QuestionnaireAnswer[];
  readonly mechanicalGradings: readonly GradingEntry[];
}): string {
  const questionById = new Map(params.questions.map((q) => [q.id, q] as const));
  const answers = params.answers.map((answer) => {
    const question = questionById.get(answer.id);
    // A click is graded mechanically; a native free-text answer has its rubric.
    if (answer.kind === "mc" || question?.type !== "multiple_choice") return answer;
    // The question type is server truth, so it gates the key, not `fromEscape`.
    // Baseline MC questions always carry both (baseline.ts superRefine).
    if (question.options === undefined || question.correct === undefined) {
      throw new Error(`buildScopingCloseLearnerInput: MC q ${question.id} missing options or key`);
    }
    const mcAnswerKey = {
      correct: question.correct,
      options: question.options,
      gradingRule: typedMcGradingRule(question.correct),
    };
    return { ...answer, mcAnswerKey };
  });
  return JSON.stringify({ answers, mechanicalGradings: params.mechanicalGradings });
}
