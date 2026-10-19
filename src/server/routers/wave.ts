import { z } from "zod/v4";
import { router, protectedProcedure } from "../trpc";
import { getWaveState } from "@/lib/course/getWaveState";

/**
 * Wave teaching loop (spec §7): state restoration only. Learner turns do not
 * go through tRPC; they stream through the route handler at
 * `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts`.
 *
 * The router is a pure interceptor: Zod-validate input → delegate to the
 * `src/lib/course/` function → return the typed payload. No business logic,
 * no LLM calls, no persistence.
 */
export const waveRouter = router({
  /** Restore wave state by ordinal (spec §7.1) — chatLog, turnsRemaining, turnBudget, closeResult. */
  getState: protectedProcedure
    .input(z.object({ courseId: z.uuid(), waveNumber: z.number().int().min(1) }))
    .query(({ ctx, input }) =>
      getWaveState({ userId: ctx.userId, courseId: input.courseId, waveNumber: input.waveNumber }),
    ),
});
