import { z } from "zod/v4";

/**
 * Input schema for one learner wave-turn submission: the trust boundary of
 * the streaming route handler (`/api/course/[courseId]/wave/[waveNumber]/turn`).
 * The discriminated payload mirrors `SubmitTurnPayload` from
 * `src/lib/course/buildLearnerInput.ts`; the lib function assumes the shape
 * is already validated.
 */
export const submitTurnInputSchema = z.object({
  courseId: z.uuid(),
  waveNumber: z.number().int().min(1),
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("chat-text"), text: z.string().min(1) }),
    z.object({
      kind: z.literal("questionnaire-answers"),
      questionnaireId: z.string().min(1),
      answers: z
        .array(
          z.discriminatedUnion("kind", [
            z.object({
              id: z.string().min(1),
              kind: z.literal("mc"),
              selected: z.enum(["A", "B", "C", "D"]),
            }),
            z.object({
              id: z.string().min(1),
              kind: z.literal("freetext"),
              text: z.string().min(1),
              fromEscape: z.boolean(),
            }),
          ]),
        )
        .min(1),
    }),
  ]),
});
