import { z } from "zod/v4";
import { MC_OPTION_KEYS } from "./mcOptionKey";

/**
 * One learner answer to one questionnaire question: a tapped MC key, or typed
 * text. `fromEscape` marks text typed on an MC question instead of a tap.
 *
 * The one source of the answer shape (issue #220). Both submit paths parse
 * it: `course.submitBaseline` (scoping) and the Wave turn route's
 * `questionnaire-answers` payload. Lib and client code use its inferred type,
 * {@link QuestionnaireAnswer}, under that one name. Clarify answers keep their
 * own `{ questionId, freetext }` shape.
 */
export const questionnaireAnswerSchema = z.discriminatedUnion("kind", [
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

/** Inferred from {@link questionnaireAnswerSchema}; one learner answer to one question. */
export type QuestionnaireAnswer = z.infer<typeof questionnaireAnswerSchema>;
