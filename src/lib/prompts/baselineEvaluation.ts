import { z } from "zod/v4";
import { BASELINE } from "@/lib/config/tuning";
import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";
import type { LlmMessage } from "@/lib/types/llm";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";
import { buildBaselinePrompt, type BaselineAssessment } from "./baseline";
import type { ClarificationExchange, Framework } from "./framework";

/**
 * P-AC-03: when an MC question is answered via the freetext-escape hatch,
 * the grader prompt prepends this sentence to the learner's prose inside
 * the sanitised `<user_message>` block. Lives here (not in `tuning.ts`)
 * because it is prompt text — `src/lib/prompts/` is the single source of
 * truth for every literal the model reads.
 */
export const FREETEXT_ESCAPE_PREFIX =
  "The learner did not select a multiple-choice option. They wrote the following instead:";

/**
 * Static instruction block for the baseline-grading turn (PRD §4.1 step 3,
 * grading half). Appended as a user message onto the growing scoping
 * conversation; the role/security block was established by the
 * clarification system prompt at the top of the conversation.
 *
 * The quality rubric is inlined verbatim from PRD §5.2 so the grader
 * calibrates against the same 0–5 scale that drives XP multipliers in
 * `tuning.XP.qualityMultipliers`. Changing this scale is a prompt change
 * AND an XP-table change; keeping the text adjacent makes the coupling
 * visible.
 */
const BASELINE_EVALUATION_TURN_INSTRUCTIONS = `<grading_task>
You will receive a batch of answered questions below. For each item, assign a quality score, decide whether it counts as correct, and record a brief rationale. These scores will be used for spaced-repetition scheduling and starting-tier placement; they must be honest and well-calibrated, not lenient.
</grading_task>

<quality_rubric>
Score every item on the PRD 0–5 quality scale:
- 0: no engagement or nonsensical response ("idk", "not sure", empty)
- 1: incorrect with clear misunderstanding
- 2: incorrect but partial understanding or correct instinct, wrong execution
- 3: correct but uncertain, incomplete, or missing key vocabulary (minimum passing score)
- 4: correct and clearly articulated
- 5: correct with depth that could teach the concept to another learner
\`isCorrect\` is \`true\` when the answer meets the passing bar (quality ≥ 3); otherwise \`false\`.
</quality_rubric>

<grading_rules>
- One evaluation per input item. Every \`questionId\` in your output must match a \`questionId\` in the input. Do not invent, drop, or reorder items (the orchestrator will reject any mismatch).
- Use the supplied \`rubric\` as the source of truth for what a good answer contains. Do not invent new expected-answer criteria.
- Non-engagement prose ("not sure", "idk", "I don't know") is quality 0 and \`isCorrect: false\` regardless of rubric — it is a valid data point, not a failure to grade.
- For items flagged \`viaEscape: true\`, the learner chose freetext instead of clicking an MC option. The prose is prefixed with an explanatory sentence in the input. Grade the prose; do not penalise the learner simply for skipping the MC buttons.
- The \`rationale\` is one or two sentences, factual and neutral. It is read by the learner indirectly (embedded in session context); keep it grading-focused, not scolding.
</grading_rules>

<output_contract>
Return JSON: { "evaluations": [ { "questionId": string, "conceptName": string, "qualityScore": 0|1|2|3|4|5, "isCorrect": boolean, "rationale": string }, ... ] }.
</output_contract>`;

/**
 * A single answered-question item handed to the grader. Free-text and
 * freetext-escape-on-MC answers share this shape; the `viaEscape` flag
 * distinguishes them so the grader input can prepend the P-AC-03
 * contextual sentence on escape answers.
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
  /** Learner's raw prose. Untrusted; sanitised inside the builder. */
  readonly learnerProse: string;
  /**
   * True if the learner reached this grader via the freetext-escape
   * affordance on an MC question. Triggers the {@link FREETEXT_ESCAPE_PREFIX}
   * prepend inside the rendered item (P-AC-03).
   */
  readonly viaEscape: boolean;
}

/** Parameters for {@link buildBaselineEvaluationPrompt}. */
export interface BaselineEvaluationPromptParams {
  /** Raw, untrusted topic. Sanitised by the clarification builder. */
  readonly topic: string;
  /** Q&A pairs from the clarification turn. */
  readonly clarifications: readonly ClarificationExchange[];
  /** Trusted framework from the framework-generation turn. */
  readonly framework: Framework;
  /** Trusted baseline from the baseline-generation turn. */
  readonly baseline: BaselineAssessment;
  /** One entry per answer needing an LLM-graded quality score. */
  readonly items: readonly BaselineEvaluationItem[];
}

/**
 * Reconstruct the baseline turn's assistant output (the baseline JSON).
 * The assistant message faithfully replays what the model produced on the
 * prior turn so the history is a coherent transcript. Exported for
 * potential reuse if further scoping turns are added later.
 */
export function buildBaselineAssistantMessage(baseline: BaselineAssessment): LlmMessage {
  return { role: "assistant", content: JSON.stringify(baseline) };
}

/**
 * Render one item's block for the grading user message. Concept name,
 * question, and rubric are trusted (our own prior output) and so embed
 * verbatim; learner prose goes through `sanitiseUserInput` so it sits
 * inside `<user_message>` and cannot inject directives. On freetext-
 * escape items the {@link FREETEXT_ESCAPE_PREFIX} sentence is prepended
 * to the prose INSIDE the sanitised block — the full text, prefix and
 * prose, is treated as data (P-AC-03, P-SEC-01).
 */
function formatItem(item: BaselineEvaluationItem): string {
  const prose = item.viaEscape
    ? `${FREETEXT_ESCAPE_PREFIX} ${item.learnerProse}`
    : item.learnerProse;
  return [
    `questionId: ${item.questionId}`,
    `conceptName: ${item.conceptName}`,
    `tier: ${item.tier}`,
    `viaEscape: ${item.viaEscape}`,
    `question: ${item.question}`,
    `rubric: ${item.rubric}`,
    `learner answer: ${sanitiseUserInput(prose)}`,
  ].join("\n");
}

/**
 * The grading-turn user-message content: task instructions, quality
 * rubric, grading rules, output contract, then the batch of items.
 * Exported so the orchestrator's tests can exercise body shape without
 * reconstructing the full history.
 */
export function buildBaselineEvaluationTurnUserContent(
  items: readonly BaselineEvaluationItem[],
): string {
  const body = items.map(formatItem).join("\n\n---\n\n");
  return `${BASELINE_EVALUATION_TURN_INSTRUCTIONS}\n\n<batch>\n${body}\n</batch>`;
}

/**
 * Build the message array for the baseline-grading turn. Continuation of
 * the scoping conversation: everything up to and including the baseline-
 * task user message (from `buildBaselinePrompt`) + the baseline assistant
 * output + the new grading-task user message.
 */
export function buildBaselineEvaluationPrompt(
  params: BaselineEvaluationPromptParams,
): readonly LlmMessage[] {
  return [
    ...buildBaselinePrompt({
      topic: params.topic,
      clarifications: params.clarifications,
      framework: params.framework,
    }),
    buildBaselineAssistantMessage(params.baseline),
    { role: "user", content: buildBaselineEvaluationTurnUserContent(params.items) },
  ];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * One grader evaluation. `qualityScore` reuses the canonical 0–5 literal
 * union so this schema and the SM-2 / XP pipeline stay in lock-step.
 */
const evaluationItemSchema = z.object({
  questionId: z.string().min(1),
  conceptName: z.string().min(1).max(BASELINE.conceptNameMaxChars),
  qualityScore: qualityScoreSchema,
  isCorrect: z.boolean(),
  rationale: z.string().min(1).max(BASELINE.rationaleMaxChars),
});

/**
 * Batch-evaluation response. The orchestrator additionally asserts the
 * set of `questionId`s matches the set submitted — mismatches are a hard
 * error, surfaced rather than swallowed (fail-loud at LLM trust boundary).
 */
export const baselineEvaluationSchema = z.object({
  evaluations: z.array(evaluationItemSchema).min(1),
});
