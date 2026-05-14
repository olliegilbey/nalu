import { z } from "zod/v4";
import { router, protectedProcedure } from "../trpc";
import { clarify } from "@/lib/course/clarify";
import { generateFramework } from "@/lib/course/generateFramework";
import { generateBaseline } from "@/lib/course/generateBaseline";
import { submitBaseline } from "@/lib/course/submitBaseline";
import { SCOPING } from "@/lib/config/tuning";

/**
 * Scoping flow (spec §3.2).
 *
 * Three procedures called in sequence by the client; each return value's
 * `nextStage` field tells the client which procedure to call next. The
 * server never sends raw LLM output — every payload is typed.
 */
export const courseRouter = router({
  /** Initiate scoping for a new topic: creates a course and returns clarifying questions. */
  clarify: protectedProcedure
    .input(z.object({ topic: z.string().min(1).max(SCOPING.maxTopicLength) }))
    .mutation(({ ctx, input }) => clarify({ userId: ctx.userId, topic: input.topic })),

  /** Generate the tier framework from the learner's clarification answers. */
  generateFramework: protectedProcedure
    .input(
      z.object({
        courseId: z.string().uuid(),
        // `responses` replaces the old flat `answers` array — each entry carries
        // the questionId so the step can reconstruct Q/A pairs for the LLM.
        responses: z
          .array(
            z.object({
              questionId: z.string().min(1),
              freetext: z.string().min(1),
            }),
          )
          .min(1)
          .max(SCOPING.maxClarifyAnswers),
      }),
    )
    .mutation(({ ctx, input }) =>
      generateFramework({
        userId: ctx.userId,
        courseId: input.courseId,
        responses: input.responses,
      }),
    ),

  /** Generate the baseline assessment questions from the stored framework. */
  generateBaseline: protectedProcedure
    .input(z.object({ courseId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      generateBaseline({ userId: ctx.userId, courseId: input.courseId }),
    ),

  /** Close scoping: grade the baseline, prime Wave 1, flip status to active. */
  submitBaseline: protectedProcedure
    .input(
      z.object({
        courseId: z.string().uuid(),
        // Discriminated union mirrors the `BaselineAnswer` type exported by
        // the lib step. The router is the trust boundary; the lib step
        // assumes the shape is already validated.
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
    )
    .mutation(({ ctx, input }) =>
      submitBaseline({
        userId: ctx.userId,
        courseId: input.courseId,
        answers: input.answers,
      }),
    ),
});
