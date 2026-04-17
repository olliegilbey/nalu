import { z } from "zod/v4";
import { BASELINE } from "@/lib/config/tuning";
import type { LlmMessage } from "@/lib/types/llm";
import { buildFrameworkPrompt, type ClarificationExchange, type Framework } from "./framework";

/** Concrete letter keys for MC options (also the `correct` domain). */
export const MC_OPTION_KEYS = ["A", "B", "C", "D"] as const;
export type McOptionKey = (typeof MC_OPTION_KEYS)[number];

/**
 * Runtime guard: the prompt text, the `options` object shape, and
 * `BASELINE.mcOptionCount` all have to stay in lock-step. `MC_OPTION_KEYS`
 * is the single source of truth; the length assertion fails loudly at
 * module load if someone ever bumps `mcOptionCount` without adding keys.
 */
if (MC_OPTION_KEYS.length !== BASELINE.mcOptionCount) {
  throw new Error(
    `MC_OPTION_KEYS length (${MC_OPTION_KEYS.length}) must equal BASELINE.mcOptionCount (${BASELINE.mcOptionCount})`,
  );
}

/**
 * Static instruction block for the baseline-generation turn
 * (PRD §4.1 step 3). Appended as a user message onto the growing scoping
 * conversation; the role/security block is already established by the
 * clarification system prompt at the top of that conversation.
 *
 * Numeric bounds come from `tuning.BASELINE` so the prompt text, the
 * orchestrator's derived scope, and the Zod schema can never drift.
 *
 * Design invariants referenced here (see `docs/ux-simulation-rust-ownership.md`
 * §10 for the full directive catalogue):
 * - P-ON-02 narrow scope: questions stay inside `scopeTiers` (supplied
 *   by the framework).
 * - P-ON-03 standalone questions: called out explicitly because batched
 *   generation otherwise chains references ("the snippet above").
 * - P-AC-02 no "Not sure" MC option: freetext escape is the UI affordance.
 * - P-AC-04 MC is deterministic: every MC carries `correct`; every
 *   question also carries `freetextRubric` so freetext-escape answers to
 *   MC questions have a grading target.
 */
const BASELINE_TURN_INSTRUCTIONS = `<question_rules>
- Generate ${BASELINE.questionsPerTier} questions per tier in scope, for a total between ${BASELINE.minQuestions} and ${BASELINE.maxQuestions}.
- Distribute questions across tiers exactly as specified — every tier in scope gets its share.
- Every question is STANDALONE: it must not reference any other question ("the snippet above", "in the previous question", "as we saw"). Each card must stand alone.
- Mix \`multiple_choice\` and \`free_text\` types. Use MC when a misconception can be cleanly framed as a tempting wrong option; use free-text when articulation quality is the signal.
- Multiple-choice questions have exactly ${MC_OPTION_KEYS.length} options keyed ${MC_OPTION_KEYS.join("/")}. Do NOT include a "Not sure" / "None of the above" / "I don't know" option. The learner interface offers a freetext escape; MC options must be real candidate answers.
- Every question — MC and free-text — carries a \`freetextRubric\`. The rubric describes what a good free-text answer would contain so the grader can score consistently if the learner uses the freetext-escape on an MC question.
- Each question has a \`conceptName\` (short, canonical) and a \`tier\` field naming the tier it probes. Use question IDs \`b1\`, \`b2\`, … in order.
</question_rules>

<output_contract>
Return JSON: { "questions": [ { "id": string, "tier": int, "conceptName": string, "type": "multiple_choice", "question": string, "options": { "A": string, "B": string, "C": string, "D": string }, "correct": "A" | "B" | "C" | "D", "freetextRubric": string } | { "id": string, "tier": int, "conceptName": string, "type": "free_text", "question": string, "freetextRubric": string }, ... ] }.
</output_contract>`;

/**
 * Parameters for {@link buildBaselinePrompt}. The framework carries the
 * scope fields (`estimatedStartingTier`, `baselineScopeTiers`) — callers
 * do not re-derive them.
 */
export interface BaselinePromptParams {
  /** Raw, untrusted topic from the learner. Sanitised by the framework builder. */
  readonly topic: string;
  /** Q&A pairs from the clarification turn. Answers sanitised downstream. */
  readonly clarifications: readonly ClarificationExchange[];
  /** Trusted framework from the framework-generation turn. */
  readonly framework: Framework;
}

/**
 * Reconstruct the framework turn's assistant output (the framework JSON)
 * so downstream turns can stack further messages onto this history.
 * Exported because the evaluation prompt builder also needs it.
 */
export function buildFrameworkAssistantMessage(framework: Framework): LlmMessage {
  return { role: "assistant", content: JSON.stringify(framework) };
}

/**
 * The baseline-turn user-message content: the explicit scope (pulled out
 * of the framework for visibility) followed by the task instructions and
 * output contract. Exported so the evaluation prompt can replay the same
 * user message on the history it builds.
 */
export function buildBaselineTurnUserContent(framework: Framework): string {
  const scope = framework.baselineScopeTiers.join(", ");
  return `Generate the baseline assessment. The estimated starting tier is ${framework.estimatedStartingTier}; probe the following tiers only: [${scope}]. Every question's \`tier\` field must be one of those numbers.\n\n${BASELINE_TURN_INSTRUCTIONS}`;
}

/**
 * Build the message array for the baseline-generation turn. Continuation
 * of the scoping conversation: clarification system prompt + topic +
 * clarification assistant output + framework-task user message (all
 * supplied by `buildFrameworkPrompt`) + the framework assistant output +
 * the new baseline-task user message.
 */
export function buildBaselinePrompt(params: BaselinePromptParams): readonly LlmMessage[] {
  return [
    ...buildFrameworkPrompt({
      topic: params.topic,
      clarifications: params.clarifications,
    }),
    buildFrameworkAssistantMessage(params.framework),
    { role: "user", content: buildBaselineTurnUserContent(params.framework) },
  ];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const mcOptionStringSchema = z.string().min(1).max(BASELINE.optionMaxChars);

/**
 * MC question branch. Four keyed options (A/B/C/D) rather than an array
 * — matches the sim's output shape and avoids ambiguity about which
 * index is correct. `correct` is one of the same four keys.
 */
const mcQuestionSchema = z.object({
  id: z.string().regex(/^b\d+$/),
  tier: z.int().positive(),
  conceptName: z.string().min(1).max(BASELINE.conceptNameMaxChars),
  type: z.literal("multiple_choice"),
  question: z.string().min(1).max(BASELINE.questionMaxChars),
  options: z.object({
    A: mcOptionStringSchema,
    B: mcOptionStringSchema,
    C: mcOptionStringSchema,
    D: mcOptionStringSchema,
  }),
  correct: z.enum(MC_OPTION_KEYS),
  freetextRubric: z.string().min(1).max(BASELINE.rubricMaxChars),
});

/** Free-text question branch. Rubric is mandatory for grader calibration. */
const freeTextQuestionSchema = z.object({
  id: z.string().regex(/^b\d+$/),
  tier: z.int().positive(),
  conceptName: z.string().min(1).max(BASELINE.conceptNameMaxChars),
  type: z.literal("free_text"),
  question: z.string().min(1).max(BASELINE.questionMaxChars),
  freetextRubric: z.string().min(1).max(BASELINE.rubricMaxChars),
});

/**
 * Discriminated union on `type` keeps TypeScript's narrowing clean in
 * the UI and the grader. Question-count bounds mirror `tuning.BASELINE`
 * so prompt contract and validated payload stay in lock-step.
 */
export const baselineSchema = z.object({
  questions: z
    .array(z.discriminatedUnion("type", [mcQuestionSchema, freeTextQuestionSchema]))
    .min(BASELINE.minQuestions)
    .max(BASELINE.maxQuestions),
});

/** Inferred baseline payload. Re-exported via `prompts/index.ts`. */
export type BaselineAssessment = z.infer<typeof baselineSchema>;

/** Single baseline question (MC or free-text). Used by UI + grader. */
export type BaselineQuestion = BaselineAssessment["questions"][number];
