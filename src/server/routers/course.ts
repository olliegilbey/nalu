import { z } from "zod/v4";
import { router, protectedProcedure } from "../trpc";
import { clarify } from "@/lib/course/clarify";
import { generateFramework } from "@/lib/course/generateFramework";
import { generateBaseline } from "@/lib/course/generateBaseline";
import { SCOPING } from "@/lib/config/tuning";

/**
 * Course router — thin transport layer for scoping procedures.
 * Validates input with Zod, delegates all logic to `src/lib/course/` steps.
 * No business logic lives here (see `src/server/routers/CLAUDE.md`).
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
        answers: z.array(z.string().min(1)).min(1).max(SCOPING.maxClarifyAnswers),
      }),
    )
    .mutation(({ ctx, input }) =>
      generateFramework({ userId: ctx.userId, courseId: input.courseId, answers: input.answers }),
    ),

  /** Generate the baseline assessment questions from the stored framework. */
  generateBaseline: protectedProcedure
    .input(z.object({ courseId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      generateBaseline({ userId: ctx.userId, courseId: input.courseId }),
    ),
});
