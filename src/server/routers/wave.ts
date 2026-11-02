import { z } from "zod/v4";
import { router, learnerProcedure } from "../trpc";
import { getWaveState } from "@/lib/course/getWaveState";
import { saveWaveRating } from "@/lib/wave-rating/saveWaveRating";
import { saveWaveRatingInputSchema } from "@/lib/types/waveRatingInput";

/**
 * Wave teaching loop (spec §7): state restoration and the Wave rating.
 * Learner turns do not go through tRPC; they stream through the route
 * handler at `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts`.
 *
 * The router is a pure interceptor: Zod-validate input → delegate to the
 * `src/lib/` function → return the typed payload. No business logic, no LLM
 * calls, no persistence.
 */
export const waveRouter = router({
  /** Restore wave state by ordinal (spec §7.1) — chatLog, turnsRemaining, turnBudget, closeResult. */
  getState: learnerProcedure
    .input(z.object({ courseId: z.uuid(), waveNumber: z.number().int().min(1) }))
    .query(({ ctx, input }) =>
      getWaveState({ userId: ctx.userId, courseId: input.courseId, waveNumber: input.waveNumber }),
    ),

  /**
   * Save the caller's rating of one closed Wave; returns the stored stars.
   * It acts on `ctx.userId` and needs an existing course, so it never mints.
   * A bad star fails BAD_REQUEST; another learner's course or an unknown Wave
   * fails NOT_FOUND; an open Wave fails PRECONDITION_FAILED. Each writes nothing.
   */
  saveRating: learnerProcedure
    .input(saveWaveRatingInputSchema)
    .mutation(({ ctx, input: { courseId, waveNumber, ...stars } }) =>
      saveWaveRating({ userId: ctx.userId, courseId, waveNumber, stars }),
    ),
});
