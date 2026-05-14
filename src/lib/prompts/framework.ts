import { z } from "zod/v4";
import { FRAMEWORK } from "@/lib/config/tuning";

/**
 * Per-tier shape.
 *
 * Every field carries `.describe()` visibility-tag text so the model
 * sees a single source of truth — these descriptions are tokenised into
 * the Cerebras strict-mode decoder context. Cerebras strict mode cannot
 * express `min/max/minLength/maxLength`, so length bounds live in
 * `.refine`; the message goes back to the model verbatim on retry.
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
