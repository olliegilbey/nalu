import { z } from "zod/v4";
import { MC_OPTION_KEYS } from "./mcOptionKey";

/** One answer in a questionnaire-answers submission: a tapped MC key, or typed text. */
const submittedAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("mc"),
    selected: z.enum(MC_OPTION_KEYS),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("freetext"),
    text: z.string().min(1),
    fromEscape: z.boolean(),
  }),
]);

/** What the learner sent in one Wave turn: chat text, or answers to the open questionnaire. */
const submitTurnPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat-text"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("questionnaire-answers"),
    questionnaireId: z.string().min(1),
    answers: z.array(submittedAnswerSchema).min(1),
  }),
]);

/**
 * Input schema for one learner Wave turn submission: the trust boundary of
 * the streaming route handler (`/api/course/[courseId]/wave/[waveNumber]/turn`).
 * The route builds the input from its path params and the body's `payload`.
 * Lib code downstream assumes the shape is already validated.
 */
export const submitTurnInputSchema = z.object({
  courseId: z.uuid(),
  waveNumber: z.number().int().min(1),
  payload: submitTurnPayloadSchema,
});

/**
 * Inferred from {@link submitTurnPayloadSchema}; the payload of one Wave turn.
 * One schema owns the parse and the type, so the two cannot drift (issue #124).
 */
export type SubmitTurnPayload = z.infer<typeof submitTurnPayloadSchema>;
