import { z } from "zod/v4";
import { FRAMEWORK } from "@/lib/config/tuning";
import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";
import type { LlmMessage } from "@/lib/types/llm";
import { buildClarificationPrompt } from "./clarification";

/**
 * Static instruction block for the framework-generation turn
 * (PRD §4.1 step 2). Module-scope so the exact string is appended every
 * call — still cache-beneficial once the clarification-turn history is
 * byte-stable, even though it now rides inside a user message rather
 * than a system message (see `feedback_scoping_is_one_conversation`).
 *
 * The role/security block is intentionally omitted: it was already
 * established by the clarification system prompt earlier in the same
 * conversation, so re-stating it would be noise.
 *
 * Numeric bounds come from `tuning.FRAMEWORK` so prompt text and Zod
 * schema can never drift.
 */
export const FRAMEWORK_TURN_INSTRUCTIONS = `<framework_rules>
- Produce between ${FRAMEWORK.minTiers} and ${FRAMEWORK.maxTiers} tiers, ordered from foundational (tier 1) to most advanced.
- Each tier needs: a unique tier number starting at 1 and incrementing by 1, a short human-readable name, a one-to-two-sentence description, and ${FRAMEWORK.minExampleConceptsPerTier} to ${FRAMEWORK.maxExampleConceptsPerTier} concrete example concepts a learner at that tier would study.
- Tiers must progress monotonically: each tier should presuppose the prior one.
- Example concepts are illustrative anchors, not the full curriculum. Pick concrete, specific concepts (e.g. "borrow checker lifetimes") rather than vague themes ("memory stuff").
- Tailor tier breadth and emphasis to the learner's clarification answers (sub-area, baseline knowledge, end goal).
- Do not teach, answer, or assess in this turn. Frameworks only.
- Emit a brief \`userMessage\`: one or two warm sentences framing the framework you produced. Do NOT enumerate the tiers in \`userMessage\`; the UI renders them from \`tiers\`.
</framework_rules>

<baseline_scope_rules>
- Also emit \`estimatedStartingTier\`: the single tier number you believe best matches the learner's current level, inferred from their clarification answers. This is a hypothesis, not a commitment — a baseline assessment will confirm or adjust it.
- Also emit \`baselineScopeTiers\`: the contiguous, ascending-sorted set of tier numbers the baseline will probe. Default to [estimatedStartingTier − 1, estimatedStartingTier, estimatedStartingTier + 1], clamped to the produced tier range. At most ${FRAMEWORK.maxBaselineScopeSize} tiers. Must include \`estimatedStartingTier\`.
- If the learner appears to be a complete beginner, estimate tier 1 and scope [1, 2]. If they appear advanced relative to the framework, estimate the top tier and scope the top two tiers.
</baseline_scope_rules>

<output_contract>
Return JSON: { "userMessage": string, "tiers": [ { "number": int, "name": string, "description": string, "exampleConcepts": string[] }, ... ], "estimatedStartingTier": int, "baselineScopeTiers": int[] }.
</output_contract>`;

/** A single Q&A pair from the prior clarification turn. */
export interface ClarificationExchange {
  /** Question text emitted by our own prior LLM call (trusted). */
  readonly question: string;
  /** Learner's free-text answer (untrusted; sanitised before dispatch). */
  readonly answer: string;
}

/**
 * Parameters for {@link buildFrameworkPrompt}. Object shape so future
 * additions (locale, learner profile) don't break callers.
 */
export interface FrameworkPromptParams {
  /** Raw, untrusted topic string from the learner. */
  readonly topic: string;
  /** Q&A pairs collected during the clarification turn. */
  readonly clarifications: readonly ClarificationExchange[];
}

/**
 * Reconstruct the clarification turn's assistant output from typed
 * inputs. The model's original output was
 * `{ questions: [q1, q2, ...] }`; we replay that shape here so the
 * conversation history accurately reflects the prior turn.
 *
 * Exported because downstream scoping modules (baseline, evaluation)
 * need to build the same assistant message when stacking further turns.
 */
export function buildClarificationAssistantMessage(
  clarifications: readonly ClarificationExchange[],
): LlmMessage {
  return {
    role: "assistant",
    content: JSON.stringify({ questions: clarifications.map((c) => c.question) }),
  };
}

/**
 * The framework-turn user-message content: the learner's answers to the
 * clarification questions (sanitised), followed by the task instructions
 * and output contract. Exported so downstream turns that need to
 * reconstruct this exact user message (baseline, evaluation) can reuse it.
 */
export function buildFrameworkTurnUserContent(
  clarifications: readonly ClarificationExchange[],
): string {
  const qa = clarifications
    .map(({ question, answer }) => `Q: ${question}\nA: ${sanitiseUserInput(answer)}`)
    .join("\n\n");
  return `The learner answered those clarifying questions:\n\n${qa}\n\nUsing the topic and these answers, now produce the proficiency framework.\n\n${FRAMEWORK_TURN_INSTRUCTIONS}`;
}

/**
 * Build the message array for the framework-generation turn. This is a
 * *continuation* of the clarification conversation — the first two
 * messages are reused verbatim from `buildClarificationPrompt` so the
 * cache prefix stays byte-stable across turns, then the prior assistant
 * output and the new framework-turn instructions are appended.
 */
export function buildFrameworkPrompt(params: FrameworkPromptParams): readonly LlmMessage[] {
  return [
    ...buildClarificationPrompt({ topic: params.topic }),
    buildClarificationAssistantMessage(params.clarifications),
    { role: "user", content: buildFrameworkTurnUserContent(params.clarifications) },
  ];
}

/**
 * Per-tier shape.
 *
 * Every field carries `.describe()` visibility-tag text so the model
 * sees a single source of truth — these descriptions are tokenised into
 * the Cerebras strict-mode decoder context, replacing the prose contract
 * that used to live in `FRAMEWORK_TURN_INSTRUCTIONS`. Cerebras strict
 * mode cannot express `min/max/minLength/maxLength`, so length bounds
 * live in `.refine`; the message goes back to the model verbatim on retry.
 */
const tierSchema = z.object({
  number: z
    .int()
    .positive()
    .describe("[UI] Tier number, starting at 1. Must be contiguous (1, 2, 3, …)."),
  name: z.string().describe("[UI] Short human-readable tier name."),
  description: z
    .string()
    .describe("[UI] One-to-two-sentence description of what a learner at this tier knows."),
  exampleConcepts: z
    .array(z.string())
    .describe(
      `[UI] Between ${FRAMEWORK.minExampleConceptsPerTier} and ${FRAMEWORK.maxExampleConceptsPerTier} concrete example concepts a learner at this tier studies. ` +
        "Pick specific concepts ('borrow checker lifetimes'), not vague themes ('memory stuff').",
    )
    .refine(
      (cs) =>
        cs.length >= FRAMEWORK.minExampleConceptsPerTier &&
        cs.length <= FRAMEWORK.maxExampleConceptsPerTier,
      {
        message: `exampleConcepts must contain between ${FRAMEWORK.minExampleConceptsPerTier} and ${FRAMEWORK.maxExampleConceptsPerTier} entries`,
      },
    ),
});

/**
 * Framework-turn response schema.
 *
 * - `userMessage` is the chat-bubble framing rendered verbatim.
 * - `tiers` is the produced ladder.
 * - `estimatedStartingTier` + `baselineScopeTiers` configure the next turn.
 *
 * Cross-field invariants (contiguous tier numbers, scope monotonicity,
 * scope membership) live in `.superRefine` because Cerebras strict mode
 * cannot express them. Each refine's `.message` is engineered to read as
 * a teacher-style retry directive — it goes back to the model verbatim
 * on the next attempt via `executeTurn`'s `ValidationGateFailure`.
 */
export const frameworkSchema = z
  .object({
    userMessage: z
      .string()
      .describe(
        "[chat] Warm chat-bubble framing the framework you produced. " +
          "Do NOT enumerate the tiers here — the UI renders them from `tiers`.",
      ),
    tiers: z
      .array(tierSchema)
      .describe(
        `[UI] Between ${FRAMEWORK.minTiers} and ${FRAMEWORK.maxTiers} tiers, ordered foundational (1) → advanced. ` +
          "Each tier presupposes the prior one.",
      )
      .refine((ts) => ts.length >= FRAMEWORK.minTiers && ts.length <= FRAMEWORK.maxTiers, {
        message: `tiers must contain between ${FRAMEWORK.minTiers} and ${FRAMEWORK.maxTiers} entries`,
      }),
    estimatedStartingTier: z
      .int()
      .positive()
      .describe(
        "[server] Best-guess tier number for the learner's current level, " +
          "inferred from their clarification answers. A baseline assessment confirms it.",
      ),
    baselineScopeTiers: z
      .array(z.int().positive())
      .describe(
        `[server] Contiguous, ascending-sorted tier numbers the baseline will probe. ` +
          `At most ${FRAMEWORK.maxBaselineScopeSize} tiers. Must include estimatedStartingTier. ` +
          "Default: [estimatedStartingTier−1, estimatedStartingTier, estimatedStartingTier+1], clamped to range.",
      )
      .refine((s) => s.length >= 1 && s.length <= FRAMEWORK.maxBaselineScopeSize, {
        message: `baselineScopeTiers must contain between 1 and ${FRAMEWORK.maxBaselineScopeSize} entries`,
      }),
  })
  .refine(({ tiers }) => tiers.every((t, i) => t.number === i + 1), {
    message: "tier numbers must be contiguous starting at 1",
    path: ["tiers"],
  })
  .superRefine((value, ctx) => {
    const tierNumbers = new Set(value.tiers.map((t) => t.number));
    if (!tierNumbers.has(value.estimatedStartingTier)) {
      ctx.addIssue({
        code: "custom",
        path: ["estimatedStartingTier"],
        message: "estimatedStartingTier must be one of the produced tier numbers",
      });
    }
    const scope = value.baselineScopeTiers;
    const ascending = scope.every((n, i) => i === 0 || n > scope[i - 1]!);
    if (!ascending) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineScopeTiers"],
        message: "baselineScopeTiers must be sorted ascending with no duplicates",
      });
    }
    const contiguous = scope.every((n, i) => i === 0 || n === scope[i - 1]! + 1);
    if (!contiguous) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineScopeTiers"],
        message: "baselineScopeTiers must be contiguous",
      });
    }
    if (!scope.every((n) => tierNumbers.has(n))) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineScopeTiers"],
        message: "baselineScopeTiers must reference produced tier numbers",
      });
    }
    if (!scope.includes(value.estimatedStartingTier)) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineScopeTiers"],
        message: "baselineScopeTiers must include estimatedStartingTier",
      });
    }
  });

/** Inferred framework type. Re-exported via `prompts/index.ts`. */
export type Framework = z.infer<typeof frameworkSchema>;
