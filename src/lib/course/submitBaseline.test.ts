import { describe, it, expect, vi, beforeEach } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { submitBaseline } from "./submitBaseline";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import { createCourse, getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { USER_ID, FRAMEWORK, BASELINE_PRECLOSE, PARSED } from "./submitBaseline.fixtures";

/**
 * Integration tests for `submitBaseline`.
 *
 * Strategy: real Postgres testcontainer for everything EXCEPT the LLM call.
 * `executeTurn` is the only seam mocked — `vi.spyOn` swaps it in-place so the
 * orchestrator drives real `getCourseById` / `ensureOpenScopingPass` /
 * `persistScopingClose` flows against the DB and we assert the post-conditions
 * the way production code will observe them.
 *
 * Why an integration test for the orchestrator (vs unit-style mocking of
 * every dep, à la `generateBaseline.test.ts`): `submitBaseline` is the
 * keystone that proves the persist transaction works end-to-end from the
 * orchestrator's call site, including the cross-task fix to
 * `submitBaseline.persist.ts` (userMessage overwrite on close). Mocking the
 * DB layer here would mask that integration risk.
 *
 * Fixtures (USER_ID / FRAMEWORK / BASELINE_PRECLOSE / PARSED) live in
 * `submitBaseline.fixtures.ts` alongside the persist suite's shared
 * helpers.
 */

/** Full AI SDK v5 `LanguageModelUsage` zero shape. */
const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/**
 * Seed user, course in scoping with framework + baseline populated, and an
 * open scoping pass (so `executeTurn`'s parent FK has somewhere to land
 * before we mock it out). Returns the course id for the test body.
 */
async function seedScopingCourse(): Promise<string> {
  await Promise.resolve(); // satisfy lint: no top-level user inserts.
  // Note: caller has already entered `withTestDb`.
  const dbModule = await import("@/db/client");
  await dbModule.db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  await updateCourseScopingState(course.id, {
    framework: FRAMEWORK,
    baseline: BASELINE_PRECLOSE,
  });
  // Pre-open the scoping pass so `ensureOpenScopingPass` returns the same row.
  await ensureOpenScopingPass(course.id);
  return course.id;
}

describe("submitBaseline (integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Happy path: orchestrator drives one LLM call, persistScopingClose
  // commits, course flips to active.
  // ---------------------------------------------------------------------------
  it("runs the close turn, persists everything, returns { userMessage, wave1Id }", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      const spy = vi
        .spyOn(executeTurnModule, "executeTurn")
        // The orchestrator only reads `parsed`; usage is ignored. Cast through
        // unknown so the test fixture doesn't need to match every branch of
        // the generic ExecuteTurnResult<T>.
        .mockResolvedValue({ parsed: PARSED, usage: ZERO_USAGE } as never);

      const result = await submitBaseline({
        courseId,
        userId: USER_ID,
        answers: [{ id: "b1", kind: "freetext", text: "my answer", fromEscape: false }],
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.userMessage).toBe(PARSED.userMessage);
      expect(result.wave1Id).toBeTruthy();

      const after = await getCourseById(courseId);
      expect(after.status).toBe("active");
      expect(after.startingTier).toBe(PARSED.startingTier);
      expect(after.currentTier).toBe(PARSED.startingTier);
      // Closing userMessage replaces the baseline-presentation framing.
      expect(after.baseline).toMatchObject({
        userMessage: PARSED.userMessage,
        immutableSummary: PARSED.immutableSummary,
        summarySeed: PARSED.summary,
        startingTier: PARSED.startingTier,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency: a second call on an already-active course must NOT call
  // executeTurn, and must return the same payload as the first call.
  // ---------------------------------------------------------------------------
  it("is idempotent: second call on 'active' course returns same payload, no LLM call", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      vi.spyOn(executeTurnModule, "executeTurn").mockResolvedValue({
        parsed: PARSED,
        usage: ZERO_USAGE,
      } as never);

      const first = await submitBaseline({
        courseId,
        userId: USER_ID,
        answers: [{ id: "b1", kind: "freetext", text: "my answer", fromEscape: false }],
      });

      // Fresh spy for the second call: assert NO further LLM invocations.
      vi.restoreAllMocks();
      const spy2 = vi.spyOn(executeTurnModule, "executeTurn");

      const second = await submitBaseline({
        courseId,
        userId: USER_ID,
        answers: [{ id: "b1", kind: "freetext", text: "my answer", fromEscape: false }],
      });

      expect(spy2).not.toHaveBeenCalled();
      expect(second.userMessage).toBe(first.userMessage);
      expect(second.wave1Id).toBe(first.wave1Id);
    });
  });

  // ---------------------------------------------------------------------------
  // Precondition: missing answer for a known question → TRPCError before any
  // LLM call. We assert the code AND that executeTurn was never invoked.
  // ---------------------------------------------------------------------------
  it("throws PRECONDITION_FAILED when answers don't cover every question", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      const spy = vi.spyOn(executeTurnModule, "executeTurn");

      await expect(
        submitBaseline({
          courseId,
          userId: USER_ID,
          answers: [], // no answers — `b1` is missing.
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Duplicate answer ids would otherwise collapse silently into the
  // `Object.fromEntries` lookup (last write wins), masking a UI bug.
  it("throws PRECONDITION_FAILED on duplicate answer ids", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      const spy = vi.spyOn(executeTurnModule, "executeTurn");

      await expect(
        submitBaseline({
          courseId,
          userId: USER_ID,
          answers: [
            { id: "b1", kind: "freetext", text: "first", fromEscape: false },
            { id: "b1", kind: "freetext", text: "second", fromEscape: false },
          ],
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Answers for unknown question ids would otherwise be silently dropped,
  // hiding a UI/state bug where the client submitted stale answers.
  it("throws PRECONDITION_FAILED on answers for unknown questions", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      const spy = vi.spyOn(executeTurnModule, "executeTurn");

      await expect(
        submitBaseline({
          courseId,
          userId: USER_ID,
          answers: [
            { id: "b1", kind: "freetext", text: "my answer", fromEscape: false },
            { id: "ghost", kind: "freetext", text: "stale", fromEscape: false },
          ],
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
