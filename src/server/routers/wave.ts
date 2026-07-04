import { z } from "zod/v4";
import { router, protectedProcedure } from "../trpc";
import { getWaveState } from "@/lib/course/getWaveState";
import { submitWaveTurn } from "@/lib/course/submitWaveTurn";
import { submitTurnInputSchema } from "./waveTurnInput";

/**
 * Wave teaching loop (spec §7).
 *
 * `getState` for restoration, `submitTurn` for per-turn input. Trust boundary —
 * `src/lib/course/submitWaveTurn` enforces §7.4 mutual-exclusion (chat-text vs
 * questionnaire-answers must match the wave's open-questionnaire state). The
 * router is a pure interceptor: Zod-validate input → delegate to the lib step →
 * return the typed payload. No business logic, no LLM calls, no persistence.
 */
export const waveRouter = router({
  /** Restore wave state by ordinal (spec §7.1) — chatLog, turnsRemaining, closeResult. */
  getState: protectedProcedure
    .input(z.object({ courseId: z.uuid(), waveNumber: z.number().int().min(1) }))
    .query(({ ctx, input }) =>
      getWaveState({ userId: ctx.userId, courseId: input.courseId, waveNumber: input.waveNumber }),
    ),

  /** Submit one learner turn against an open Wave (spec §7.2 + §7.4). Returns mid-turn or close-turn result. */
  submitTurn: protectedProcedure
    // Schema shared with the streaming route handler — see waveTurnInput.ts.
    .input(submitTurnInputSchema)
    .mutation(({ ctx, input }) =>
      submitWaveTurn({
        userId: ctx.userId,
        courseId: input.courseId,
        waveNumber: input.waveNumber,
        payload: input.payload,
      }),
    ),
});
