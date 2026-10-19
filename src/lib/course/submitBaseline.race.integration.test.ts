import { describe, it, expect, vi, beforeEach } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { submitBaseline } from "./submitBaseline";
import { persistScopingClose } from "./submitBaseline.persist";
import { getState } from "./getState";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import * as coursesModule from "@/db/queries/courses";
import { getOpenWaveByCourse } from "@/db/queries/waves";
import * as scopingPassesModule from "@/db/queries/scopingPasses";
import { USER_ID, PARSED, MERGED, seedScopingCourse } from "./submitBaseline.fixtures";

/**
 * A scoping-close re-send racing the original close (issue #103).
 *
 * After a reload mid-Turn, the Retry row can re-send `submitBaseline` while
 * the server still runs the original. The client cannot see that call. So
 * whichever order the two land in, the re-send must return the winner's
 * payload and leave the closed course intact. Each test commits the winner
 * at one point inside the re-send.
 */

describe("submitBaseline racing the original close (integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("replays the winner's close when it commits between the re-send's read and its answer write", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      const scopingPassId = (await scopingPassesModule.ensureOpenScopingPass(courseId)).id;
      const readCourse = coursesModule.getCourseById;
      // The re-send reads 'scoping'. The original then commits the close.
      vi.spyOn(coursesModule, "getCourseById").mockImplementationOnce(async (...args) => {
        const stale = await readCourse(...args);
        await persistScopingClose({ courseId, scopingPassId, parsed: PARSED, merged: MERGED });
        return stale;
      });
      const llm = vi.spyOn(executeTurnModule, "executeTurn");

      const result = await submitBaseline({
        courseId,
        userId: USER_ID,
        answers: [{ id: "b1", kind: "freetext", text: "my answer", fromEscape: false }],
      });

      expect(llm).not.toHaveBeenCalled();
      const wave1 = await getOpenWaveByCourse(courseId);
      expect(result).toEqual({
        userMessage: PARSED.userMessage,
        wave1Id: wave1?.id,
        freeTextXpAwarded: 0,
      });
      // The closed baseline survives, so the course still loads.
      const state = await getState({ userId: USER_ID, courseId });
      expect(state.scopingResult).toEqual({
        closingMessage: PARSED.userMessage,
        startingTier: MERGED.startingTier,
      });
    });
  });

  it("replays the winner's close when it commits before the re-send looks up the scoping pass", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      const ensurePass = scopingPassesModule.ensureOpenScopingPass;
      const scopingPassId = (await ensurePass(courseId)).id;
      // The original commits, closing the pass. The re-send then finds no
      // open pass and cannot open a second one (unique per course).
      vi.spyOn(scopingPassesModule, "ensureOpenScopingPass").mockImplementationOnce(async (id) => {
        await persistScopingClose({ courseId, scopingPassId, parsed: PARSED, merged: MERGED });
        return ensurePass(id);
      });
      const llm = vi.spyOn(executeTurnModule, "executeTurn");

      const result = await submitBaseline({
        courseId,
        userId: USER_ID,
        answers: [{ id: "b1", kind: "freetext", text: "my answer", fromEscape: false }],
      });

      expect(llm).not.toHaveBeenCalled();
      expect(result.wave1Id).toBe((await getOpenWaveByCourse(courseId))?.id);
    });
  });

  it("replays the winner's close when the re-send's LLM step fails after the winner commits", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      const scopingPassId = (await scopingPassesModule.ensureOpenScopingPass(courseId)).id;
      // Both calls reserved the same turn_index. The original commits first,
      // so the re-send's batch hits the unique index.
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(async () => {
        await persistScopingClose({ courseId, scopingPassId, parsed: PARSED, merged: MERGED });
        throw new Error("duplicate key value violates unique constraint on context_messages");
      });

      const result = await submitBaseline({
        courseId,
        userId: USER_ID,
        answers: [{ id: "b1", kind: "freetext", text: "my answer", fromEscape: false }],
      });

      expect(result.wave1Id).toBe((await getOpenWaveByCourse(courseId))?.id);
    });
  });
});
