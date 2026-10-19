import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { PROFILE } from "@/lib/config/tuning";
import { appRouter } from "./index";

/**
 * Integration tests for `profile.ts`: the learner saves custom instructions
 * and reads them back. Drives `appRouter.createCaller`, so each call runs
 * `protectedProcedure`, which provisions the caller's `user_profiles` row.
 */

const LEARNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEARNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Characters an XML-ish prompt treats as markup. Storage keeps them raw;
// escaping happens once, at render (issue #236).
const PREFERENCE = "I learn best through analogies. Use <code> & a > b, please.";

describe("profile custom instructions", () => {
  it("saves a preference and reads it back byte for byte", async () => {
    await withTestDb(async () => {
      const caller = appRouter.createCaller({ userId: LEARNER_A });

      const saved = await caller.profile.setCustomInstructions({
        customInstructions: PREFERENCE,
      });
      expect(saved).toEqual({ customInstructions: PREFERENCE });

      const read = await caller.profile.getCustomInstructions();
      expect(read).toEqual({ customInstructions: PREFERENCE });
    });
  });

  it("clears the preference when a whitespace-only save follows a save", async () => {
    await withTestDb(async () => {
      const caller = appRouter.createCaller({ userId: LEARNER_A });
      await caller.profile.setCustomInstructions({ customInstructions: PREFERENCE });

      const cleared = await caller.profile.setCustomInstructions({
        customInstructions: "  \n\t ",
      });
      expect(cleared).toEqual({ customInstructions: null });

      const read = await caller.profile.getCustomInstructions();
      expect(read).toEqual({ customInstructions: null });
    });
  });

  it("rejects an over-cap save with BAD_REQUEST and keeps the stored value", async () => {
    await withTestDb(async () => {
      const caller = appRouter.createCaller({ userId: LEARNER_A });
      await caller.profile.setCustomInstructions({ customInstructions: PREFERENCE });

      await expect(
        caller.profile.setCustomInstructions({
          customInstructions: "a".repeat(PROFILE.maxCustomInstructionsLength + 1),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      const read = await caller.profile.getCustomInstructions();
      expect(read).toEqual({ customInstructions: PREFERENCE });
    });
  });

  // Each isolation test gives learner B a profile row before A saves. A
  // write that missed its `WHERE id =` would then reach B's row too.
  it("leaves learner B reading null after learner A saves", async () => {
    await withTestDb(async () => {
      const learnerA = appRouter.createCaller({ userId: LEARNER_A });
      const learnerB = appRouter.createCaller({ userId: LEARNER_B });
      expect(await learnerB.profile.getCustomInstructions()).toEqual({ customInstructions: null });

      await learnerA.profile.setCustomInstructions({ customInstructions: PREFERENCE });

      expect(await learnerB.profile.getCustomInstructions()).toEqual({ customInstructions: null });
    });
  });

  it("leaves learner B's own preference unchanged after learner A saves", async () => {
    await withTestDb(async () => {
      const learnerA = appRouter.createCaller({ userId: LEARNER_A });
      const learnerB = appRouter.createCaller({ userId: LEARNER_B });
      const preferenceB = "Keep sessions short and varied.";
      await learnerB.profile.setCustomInstructions({ customInstructions: preferenceB });

      await learnerA.profile.setCustomInstructions({ customInstructions: PREFERENCE });

      expect(await learnerB.profile.getCustomInstructions()).toEqual({
        customInstructions: preferenceB,
      });
      expect(await learnerA.profile.getCustomInstructions()).toEqual({
        customInstructions: PREFERENCE,
      });
    });
  });
});
