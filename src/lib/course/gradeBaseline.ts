import { BASELINE, PROGRESSION } from "@/lib/config/tuning";
import { generateStructured } from "@/lib/llm/generate";
import {
  baselineEvaluationSchema,
  buildBaselineEvaluationPrompt,
  type BaselineAssessment,
  type BaselineEvaluationItem,
  type BaselineQuestion,
  type ClarificationExchange,
  type Framework,
  type McOptionKey,
} from "@/lib/prompts";
import type { LlmUsage } from "@/lib/types/llm";
import type { QualityScore } from "@/lib/types/spaced-repetition";

/**
 * A single learner answer to a baseline question. The UI submits this
 * shape at the end of client-side answer collection (P-AC-05).
 *
 * - `mc`: the learner clicked an MC option.
 * - `freetext`: native free-text answer, or an MC question answered via
 *   the freetext-escape affordance — indicated by `fromEscape: true`
 *   (P-AC-03). The same shape serves both because DRY: the grader input
 *   only needs to know the learner's words, not which affordance they
 *   used, except to prepend the P-AC-03 prefix.
 */
export type BaselineAnswer =
  | { readonly id: string; readonly kind: "mc"; readonly selected: McOptionKey }
  | {
      readonly id: string;
      readonly kind: "freetext";
      readonly text: string;
      /** True if the learner escaped out of an MC question into freetext. */
      readonly fromEscape: boolean;
    };

/** Per-question grading result, merged across mechanical and LLM paths. */
export interface QuestionGrading {
  readonly questionId: string;
  readonly conceptName: string;
  readonly tier: number;
  readonly quality: QualityScore;
  /** Matches the LLM grader's `isCorrect` (quality ≥ passing threshold). */
  readonly isCorrect: boolean;
  readonly rationale: string;
}

export interface GradeBaselineParams {
  /** Raw, untrusted topic from the scoping conversation. */
  readonly topic: string;
  /** Clarification Q&A, needed to rebuild the scoping history. */
  readonly clarifications: readonly ClarificationExchange[];
  /** Framework from the framework-generation turn. */
  readonly framework: Framework;
  /** Baseline assessment from the baseline-generation turn. */
  readonly baseline: BaselineAssessment;
  /** The learner's answers collected client-side. One per question. */
  readonly answers: readonly BaselineAnswer[];
}

export interface GradeBaselineResult {
  readonly gradings: readonly QuestionGrading[];
  /** Usage from the batched grader call. Zero-filled if no LLM call was needed. */
  readonly usage: LlmUsage;
}

/** Quality score for a correct MC click (from `tuning.BASELINE`). */
const MC_CORRECT_QUALITY: QualityScore = BASELINE.mcCorrectQuality as QualityScore;
/** Quality score for an incorrect MC click. */
const MC_INCORRECT_QUALITY: QualityScore = BASELINE.mcIncorrectQuality as QualityScore;

/**
 * `LlmUsage` (= AI SDK `LanguageModelUsage`) requires detail sub-objects
 * even when no call was made. Zero-filled across the board — cache /
 * reasoning fields are `0` rather than `undefined` so the merge reads
 * cleanly downstream if a caller ever aggregates token counts.
 */
const ZERO_USAGE: LlmUsage = {
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
type QuestionSplit =
  | { readonly kind: "mechanical"; readonly qid: string; readonly grading: QuestionGrading }
  | { readonly kind: "llm"; readonly qid: string; readonly item: BaselineEvaluationItem };

/**
 * Deterministic MC grading (P-AC-04). A correct click maps to
 * `BASELINE.mcCorrectQuality`; an incorrect click to
 * `BASELINE.mcIncorrectQuality`. `isCorrect` follows from
 * `quality ≥ PROGRESSION.passingQualityScore`, which keeps the boundary
 * consistent with tier-advancement logic.
 */
function gradeMc(question: BaselineQuestion, selected: McOptionKey): QuestionGrading {
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
function toEvaluationItem(
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
function splitOne(question: BaselineQuestion, answer: BaselineAnswer): QuestionSplit {
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

/**
 * Drive the baseline-grading turn (PRD §4.1 step 3, grading half).
 *
 * Splits the answer batch:
 *
 *   - MC-on-MC (click answer): graded mechanically, no LLM call.
 *   - Everything else (native free-text, freetext-escape on MC): batched
 *     into a single `generateStructured` call with the evaluation schema.
 *
 * This is the P-ON-04 invariant: baseline grading is at most one LLM
 * call, never one-per-card. When every answer is an MC click, no LLM
 * call runs at all and usage is zero-filled.
 *
 * Merged results are returned in input (question-array) order, not
 * answer-array order, so downstream consumers can zip with
 * `baseline.questions`.
 *
 * Fail-loud invariants at the LLM boundary:
 *   - Every LLM-returned `questionId` must be one we submitted.
 *   - Every LLM-submitted `questionId` must come back in the response.
 *   - No answer may lack a grading when the merge completes.
 */
export async function gradeBaseline(params: GradeBaselineParams): Promise<GradeBaselineResult> {
  // Lookup: question by id. Built once; input trust-boundary checks below.
  const byId: Readonly<Record<string, BaselineQuestion>> = Object.fromEntries(
    params.baseline.questions.map((q) => [q.id, q] as const),
  );

  // Validate answers: every id known, no duplicates. Functional scan
  // avoids the mutable-Set accumulator that the `functional/immutable-data`
  // rule would flag.
  const unknown = params.answers.find((a) => !(a.id in byId));
  if (unknown) {
    throw new Error(`answer for unknown question id: ${unknown.id}`);
  }
  const answerIds = params.answers.map((a) => a.id);
  const duplicate = answerIds.find((id, i) => answerIds.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw new Error(`duplicate answer for question id: ${duplicate}`);
  }

  const answerById: Readonly<Record<string, BaselineAnswer>> = Object.fromEntries(
    params.answers.map((a) => [a.id, a] as const),
  );

  // Partition questions into mechanical vs LLM splits in one pass.
  // Preserves baseline.questions order so the merge can zip by index.
  const splits: readonly QuestionSplit[] = params.baseline.questions.map((question) => {
    const answer = answerById[question.id];
    if (!answer) throw new Error(`no answer provided for question ${question.id}`);
    return splitOne(question, answer);
  });

  const llmItems: readonly BaselineEvaluationItem[] = splits.flatMap((s) =>
    s.kind === "llm" ? [s.item] : [],
  );

  // All-MC shortcut: no LLM call, zero-filled usage.
  if (llmItems.length === 0) {
    const gradings = splits.map((s) => {
      if (s.kind !== "mechanical") {
        throw new Error(`no grading produced for question ${s.qid}`);
      }
      return s.grading;
    });
    return { gradings, usage: ZERO_USAGE };
  }

  const messages = buildBaselineEvaluationPrompt({
    topic: params.topic,
    clarifications: params.clarifications,
    framework: params.framework,
    baseline: params.baseline,
    items: llmItems,
  });
  const result = await generateStructured(baselineEvaluationSchema, messages);

  // Validate the grader's response against the submitted ids — fail loud
  // on any drift (stragglers, duplicates, omissions). The orchestrator
  // treats the LLM as an external surface.
  const submittedIds = llmItems.map((i) => i.questionId);
  const returnedIds = result.object.evaluations.map((e) => e.questionId);
  const unsubmitted = returnedIds.find((id) => !submittedIds.includes(id));
  if (unsubmitted !== undefined) {
    throw new Error(`grader returned evaluation for unsubmitted question id: ${unsubmitted}`);
  }
  const dupEval = returnedIds.find((id, i) => returnedIds.indexOf(id) !== i);
  if (dupEval !== undefined) {
    throw new Error(`grader returned duplicate evaluation for question id: ${dupEval}`);
  }
  const missing = submittedIds.filter((id) => !returnedIds.includes(id));
  if (missing.length > 0) {
    throw new Error(`grader omitted evaluations for: ${missing.join(", ")}`);
  }

  const llmGradings: Readonly<Record<string, QuestionGrading>> = Object.fromEntries(
    result.object.evaluations.map((ev) => {
      // `byId[ev.questionId]` is guaranteed by the unsubmitted check above.
      const question = byId[ev.questionId]!;
      return [
        ev.questionId,
        {
          questionId: ev.questionId,
          conceptName: ev.conceptName,
          tier: question.tier,
          quality: ev.qualityScore,
          isCorrect: ev.isCorrect,
          rationale: ev.rationale,
        },
      ] as const;
    }),
  );

  // Merge in question-array order so callers can zip with `baseline.questions`.
  const gradings: readonly QuestionGrading[] = splits.map((s) => {
    if (s.kind === "mechanical") return s.grading;
    const g = llmGradings[s.qid];
    if (!g) throw new Error(`no grading produced for question ${s.qid}`);
    return g;
  });

  return { gradings, usage: result.usage };
}
