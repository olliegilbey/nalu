import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { scopingPasses } from "@/db/schema";
import { submitBaseline } from "./submitBaseline";
import { persistScopingClose } from "./submitBaseline.persist";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import { getCourseById } from "@/db/queries/courses";
import { getOpenWaveByCourse } from "@/db/queries/waves";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { updateCourseScopingState } from "@/db/queries/courses.scoping";
import type { CloseTurnBase } from "@/lib/prompts/closeTurn";
import { USER_ID, PARSED, MERGED, ZERO_USAGE, seedScopingCourse } from "./submitBaseline.fixtures";

/** A two-tier baseline: an MC question at tier 1 and a free-text one at tier 2. */
const TWO_TIER_BASELINE = {
  userMessage: "baseline framing",
  questions: [
    {
      id: "m1",
      type: "multiple_choice" as const,
      prompt: "Which keyword moves ownership?",
      options: { A: "none, assignment moves", B: "move", C: "own", D: "take" },
      correct: "A" as const,
      freetextRubric: "Assignment moves ownership; no keyword is needed.",
      conceptName: "ownership",
      tier: 1,
    },
    {
      id: "f2",
      type: "free_text" as const,
      prompt: "What is a borrow?",
      freetextRubric: "A reference that uses a value without taking ownership.",
      conceptName: "borrowing",
      tier: 2,
    },
  ],
  responses: [],
  gradings: [],
};

/** The close turn's gradings for {@link TWO_TIER_BASELINE}: the free-text answer is correct. */
const TWO_TIER_GRADINGS: CloseTurnBase["gradings"] = [
  { kind: "mc-index", questionId: "m1", rationale: "Wrong click. Revisit moves." },
  {
    kind: "free-text",
    questionId: "f2",
    verdict: "correct",
    qualityScore: 5,
    conceptName: "borrowing",
    conceptTier: 2,
    rationale: "Clear answer. Build on it.",
  },
];

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

describe("submitBaseline (integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Happy path: orchestrator drives one LLM call, persistScopingClose
  // commits, course flips to active.
  // ---------------------------------------------------------------------------
  it("runs the close turn, persists everything, returns { userMessage, wave1Id }", async () => {
    await withTestDb(async (db) => {
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
      expect(after.startingTier).toBe(MERGED.startingTier);
      expect(after.currentTier).toBe(MERGED.startingTier);
      // Closing userMessage replaces the baseline-presentation framing.
      expect(after.baseline).toMatchObject({
        userMessage: PARSED.userMessage,
        summarySeed: PARSED.summary,
        startingTier: MERGED.startingTier,
      });
      // Issue #93: the scoping close no longer writes a second summary.
      expect(after.baseline).not.toHaveProperty("immutableSummary");

      // The scoping pass closes in the same transaction (issue #99).
      const passes = await db
        .select()
        .from(scopingPasses)
        .where(eq(scopingPasses.courseId, courseId));
      expect(passes).toEqual([
        expect.objectContaining({ status: "closed", closedAt: expect.any(Date) }),
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #94: the Harness places the learner. The mocked reply still names
  // a tier, as the old schema asked the model to. Tier 1's only answer is a
  // wrong click, so the learner starts at tier 1 whatever the model says.
  // ---------------------------------------------------------------------------
  it("places the learner from the graded answers, ignoring a tier the model names", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();
      await updateCourseScopingState(courseId, { baseline: TWO_TIER_BASELINE });
      vi.spyOn(executeTurnModule, "executeTurn").mockResolvedValue({
        parsed: { ...PARSED, gradings: TWO_TIER_GRADINGS, startingTier: 2 },
        usage: ZERO_USAGE,
      } as never);

      await submitBaseline({
        courseId,
        userId: USER_ID,
        answers: [
          { id: "m1", kind: "mc", selected: "B" },
          { id: "f2", kind: "freetext", text: "a borrow is a reference", fromEscape: false },
        ],
      });

      const after = await getCourseById(courseId);
      expect(after.startingTier).toBe(1);
      expect(after.currentTier).toBe(1);
      expect(after.baseline).toMatchObject({ startingTier: 1 });
      expect((await getOpenWaveByCourse(courseId))?.tier).toBe(1);
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

  // ---------------------------------------------------------------------------
  // Concurrent-submit race recovery: two tabs both pass the precondition gate
  // (course is 'scoping' at top), both call the LLM. The loser's persist
  // hits the partial unique index `waves_one_open_per_course` — the orchestrator
  // catches the unique-violation, re-reads the now-active course, and replays
  // the cached payload so the user sees the winner's result rather than a
  // 500. Token waste on the loser is acknowledged as acceptable in the TODO.
  //
  // Simulation strategy: have `executeTurn` (the LLM seam) commit a full
  // `persistScopingClose` for the same course mid-call. That stands in for
  // the winner finishing while the loser is still mid-LLM. When the outer
  // `submitBaseline`'s own persist runs, openWave hits the unique-violation,
  // the catch handler kicks in, and the cached payload is returned.
  // ---------------------------------------------------------------------------
  it("recovers from concurrent-submit race via cached replay", async () => {
    await withTestDb(async () => {
      const courseId = await seedScopingCourse();

      const winnerOpening = `${PARSED.nextUnitBlueprint.openingText} (winner)`;
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(async () => {
        // Stand in for a concurrent winner committing while we're "in the LLM".
        // We persist with a distinct openingText so we can later prove the
        // returned wave1 is the winner's row, not a phantom from the loser.
        await persistScopingClose({
          courseId,
          scopingPassId: (await ensureOpenScopingPass(courseId)).id,
          parsed: {
            ...PARSED,
            nextUnitBlueprint: { ...PARSED.nextUnitBlueprint, openingText: winnerOpening },
          },
          merged: MERGED,
        });
        return { parsed: PARSED, usage: ZERO_USAGE } as never;
      });

      const result = await submitBaseline({
        courseId,
        userId: USER_ID,
        answers: [{ id: "b1", kind: "freetext", text: "my answer", fromEscape: false }],
      });

      // Course is active and the returned wave is the winner's open Wave 1.
      const after = await getCourseById(courseId);
      expect(after.status).toBe("active");
      const wave1 = await getOpenWaveByCourse(courseId);
      expect(wave1).not.toBeNull();
      expect(result.wave1Id).toBe(wave1!.id);
      // The cached payload's userMessage is the one persisted by the winner
      // (PARSED.userMessage — we did not vary it). The loser's would-be
      // userMessage is identical here because we share PARSED, but this still
      // proves we returned the cached read path: the seedSource carries the
      // winner-marked openingText.
      expect(wave1!.seedSource).toMatchObject({
        kind: "scoping_handoff",
        blueprint: { openingText: winnerOpening },
      });
      expect(result.userMessage).toBe(PARSED.userMessage);
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
