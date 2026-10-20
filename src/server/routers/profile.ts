import { router, protectedProcedure } from "../trpc";
import {
  getCustomInstructions,
  saveCustomInstructions,
} from "@/lib/learner-profile/customInstructions";
import { setCustomInstructionsInputSchema } from "@/lib/types/customInstructionsInput";

/**
 * The learner's own profile: custom instructions only, for now. Neither
 * procedure takes a user id. Both act on `ctx.userId`, so a learner can
 * read and write only their own preferences.
 */
export const profileRouter = router({
  /** Read the caller's custom instructions; null when none are set. */
  getCustomInstructions: protectedProcedure.query(async ({ ctx }) => ({
    customInstructions: await getCustomInstructions(ctx.userId),
  })),

  /**
   * Save the caller's custom instructions. The schema trims, caps and maps
   * empty to null; an over-cap text fails with BAD_REQUEST and writes nothing.
   */
  setCustomInstructions: protectedProcedure
    .input(setCustomInstructionsInputSchema)
    .mutation(async ({ ctx, input }) => ({
      customInstructions: await saveCustomInstructions(ctx.userId, input.customInstructions),
    })),
});
