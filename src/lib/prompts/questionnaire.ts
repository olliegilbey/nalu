import { z } from "zod/v4";

/**
 * Canonical four-option key tuple for multiple-choice questions. Used by
 * `questionSchema` and re-exported so per-stage schemas can pin themselves
 * to the same letters without duplicating the constant.
 */
export const MC_OPTION_KEYS = ["A", "B", "C", "D"] as const;
export type McOptionKey = (typeof MC_OPTION_KEYS)[number];

/**
 * Shared question shape used identically by clarify, baseline, and (later)
 * teaching quizzes. Visibility tiers are documented inline via .describe()
 * prefixes: [UI] = rendered to the learner, [server] = harness-only state
 * never shown, [chat] = chat-bubble prose. Cerebras tokenises descriptions
 * into the decoder's context so these annotations *are* the model's guide.
 *
 * Cross-field invariants (every MC has `correct` when graded; baseline
 * adds `conceptName`/`tier`) are enforced by per-stage `.superRefine` on
 * the wrapping stage schema, not here — clarify needs the looser shape.
 */
export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z
      .string()
      .describe("[server] Stable identifier so responses can be matched back to questions."),
    type: z.literal("free_text").describe("[server] Question kind discriminator."),
    prompt: z.string().describe("[UI] The question shown to the learner."),
    freetextRubric: z
      .string()
      .describe(
        "[server] How to grade a free-text response. For elicitation (clarify) " +
          "this can be a one-liner like 'no grading — informational'. Never shown to the learner.",
      ),
    conceptName: z
      .string()
      .optional()
      .describe("[server] Concept this question probes. Required for baseline + teaching quizzes."),
    tier: z
      .int()
      .positive()
      .optional()
      .describe(
        "[server] Framework tier this question targets. Required for baseline + teaching quizzes.",
      ),
  }),
  z.object({
    id: z.string().describe("[server] Stable identifier."),
    type: z.literal("multiple_choice").describe("[server] Question kind discriminator."),
    prompt: z.string().describe("[UI] The question shown to the learner."),
    options: z
      .object({
        A: z.string(),
        B: z.string(),
        C: z.string(),
        D: z.string(),
      })
      .describe(
        "[UI] Four keyed options shown to the learner. Learner can also bypass " +
          "via the free-text escape rendered alongside the buttons.",
      ),
    correct: z
      .enum(MC_OPTION_KEYS)
      .optional()
      .describe(
        "[server] Correct option key. NEVER shown to the learner. " +
          "PRESENT for graded questions (baseline, quiz) so the client can score MC immediately " +
          "without a round-trip; ABSENT for elicitation (clarify) where there is no right answer.",
      ),
    freetextRubric: z
      .string()
      .describe("[server] How to grade if the learner uses the free-text escape. Never shown."),
    conceptName: z.string().optional().describe("[server] Concept probed."),
    tier: z.int().positive().optional().describe("[server] Framework tier targeted."),
  }),
]);

/** Inferred Question union — re-exported for stage schemas + UI typing. */
export type Question = z.infer<typeof questionSchema>;

/**
 * Questionnaire wrapper. Per-stage `.refine` on the wrapping schema tightens
 * the count bounds (clarify: 2–4; baseline: derived from scope tiers).
 * Cerebras strict mode forbids `minItems`/`maxItems` on the wire side, so
 * count enforcement runs Zod-side via `.refine`.
 */
export const questionnaireSchema = z
  .object({
    questions: z
      .array(questionSchema)
      .describe(
        "One or more questions. UI shows them one at a time; the learner submits " +
          "the whole questionnaire before the model sees responses. " +
          "Clarify: 2–4 questions; baseline: count determined by scope tiers.",
      ),
  })
  .refine((q) => q.questions.length >= 1, {
    message: "questionnaire must contain at least one question",
    path: ["questions"],
  });

export type Questionnaire = z.infer<typeof questionnaireSchema>;

/**
 * One learner reply. Exactly one of `choice` | `freetext` is set — enforced
 * by superRefine because Cerebras strict mode rejects `oneOf` discrimination
 * on plain unions without an explicit discriminator field.
 */
export const responseSchema = z
  .object({
    questionId: z.string().describe("[server] Matches the question's id."),
    choice: z
      .enum(MC_OPTION_KEYS)
      .optional()
      .describe(
        "[UI→server] MC option key selected by the learner. Set only when the learner clicks an MC option.",
      ),
    freetext: z
      .string()
      .optional()
      .describe(
        "[UI→server] Free-text body. Set for free-text questions or when the learner uses the freetext-escape on an MC question.",
      ),
  })
  .superRefine((val, ctx) => {
    const both = val.choice !== undefined && val.freetext !== undefined;
    const neither = val.choice === undefined && val.freetext === undefined;
    if (both || neither) {
      ctx.addIssue({
        code: "custom",
        message: "response must have exactly one of `choice` or `freetext`",
        path: [],
      });
    }
  });

export type Response = z.infer<typeof responseSchema>;

/** Wrapper for serialising the learner's full set of replies. */
export const responsesSchema = z.object({
  responses: z.array(responseSchema),
});

export type Responses = z.infer<typeof responsesSchema>;
