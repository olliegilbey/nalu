import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { persistScopingClose } from "./submitBaseline.persist";
import { createCourse, getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { getConceptsByCourse } from "@/db/queries/concepts";
import { openWave, getOpenWaveByCourse } from "@/db/queries/waves";
import { getMessagesForWave } from "@/db/queries/contextMessages";

/**
 * Integration tests for `persistScopingClose`.
 *
 * Runs against the real Postgres testcontainer (no mocks) so the SQL paths,
 * JSONB casts, and partial unique indexes all exercise the same code as
 * production. Each `withTestDb` call truncates every table first.
 */

/** Fixed UUID for the test user — avoids runtime UUID generation. */
const USER_ID = "55555555-5555-5555-5555-555555555555";

/** Minimal valid framework matching `frameworkJsonbSchema`. */
const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["b"] },
  ],
} as const;

/** Minimal valid baseline (pre-close shape) with one free-text question. */
const BASELINE_PRECLOSE = {
  userMessage: "baseline framing",
  questions: [
    {
      id: "b1",
      type: "free_text" as const,
      prompt: "What is ownership?",
      freetextRubric: "rubric",
      conceptName: "ownership",
      tier: 2,
    },
  ],
  responses: [{ questionId: "b1", freetext: "the rule about owning values" }],
  gradings: [],
} as const;

/**
 * Minimal valid parsed close-turn payload (post-Zod).
 *
 * Plain (non-`as const`) object so `gradings` is a mutable array — matches
 * the inferred `ScopingCloseTurn` shape from `makeScopingCloseSchema`.
 * `verdict`/`qualityScore` retain literal types via `satisfies` below.
 */
const PARSED: import("@/lib/prompts/scopingClose").ScopingCloseTurn = {
  userMessage: "closing chat message",
  immutableSummary: "durable profile",
  summary: "evolving seed",
  startingTier: 2,
  // The base schema also requires `gradings` on the parsed payload, but
  // persistScopingClose only consumes `merged.gradings`, not parsed.gradings.
  // Keep this here as a typed value to match `ScopingCloseTurn`.
  gradings: [
    {
      questionId: "b1",
      conceptName: "ownership",
      conceptTier: 2,
      verdict: "correct",
      qualityScore: 5,
      rationale: "good",
    },
  ],
  nextUnitBlueprint: {
    topic: "Ownership basics",
    outline: ["intro", "examples"],
    openingText: "Welcome to lesson 1.",
  },
};

/** Canonical-ordered gradings + deterministic XP from `mergeAndComputeXp`. */
const MERGED: import("./submitBaseline.merge").MergeAndComputeXpResult = {
  gradings: [
    {
      questionId: "b1",
      conceptName: "ownership",
      conceptTier: 2,
      verdict: "correct",
      qualityScore: 5,
      rationale: "good",
    },
  ],
  totalXp: 50,
};

/**
 * Seed user, create a course in scoping with framework + baseline already
 * populated, then run the test body against the same `withTestDb` instance.
 */
async function seedScopingCourseAndRun(fn: (courseId: string) => Promise<void>): Promise<void> {
  return withTestDb(async (db) => {
    await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
    const course = await createCourse({ userId: USER_ID, topic: "Rust" });
    await updateCourseScopingState(course.id, {
      framework: FRAMEWORK,
      baseline: BASELINE_PRECLOSE,
    });
    await fn(course.id);
  });
}

describe("persistScopingClose (integration)", () => {
  // -------------------------------------------------------------------------
  // Happy path: every effect lands as expected.
  // -------------------------------------------------------------------------
  it("widens baseline JSONB, upserts concept, opens Wave 1, persists openingText, flips status, sets tiers and XP", async () => {
    await seedScopingCourseAndRun(async (courseId) => {
      const result = await persistScopingClose({ courseId, parsed: PARSED, merged: MERGED });
      expect(result.wave1Id).toBeTruthy();

      // 1. Course flipped to active with tiers and XP applied.
      const after = await getCourseById(courseId);
      expect(after.status).toBe("active");
      expect(after.startingTier).toBe(2);
      expect(after.currentTier).toBe(2);
      expect(after.totalXp).toBe(50);
      expect(after.summary).toBe("evolving seed");

      // 2. Baseline JSONB widened to the closed shape.
      expect(after.baseline).toMatchObject({
        immutableSummary: "durable profile",
        summarySeed: "evolving seed",
        startingTier: 2,
        // Gradings overwritten with the merged canonical-order list.
        gradings: [
          expect.objectContaining({ questionId: "b1", qualityScore: 5, verdict: "correct" }),
        ],
        // Pre-existing questions/responses still preserved.
        questions: [expect.objectContaining({ id: "b1" })],
        responses: [expect.objectContaining({ questionId: "b1" })],
      });

      // 3. Exactly one concept row inserted with SM-2 defaults (NULL).
      const concepts = await getConceptsByCourse(courseId);
      expect(concepts).toHaveLength(1);
      expect(concepts[0]).toMatchObject({
        name: "ownership",
        tier: 2,
        lastReviewedAt: null,
        nextReviewAt: null,
      });

      // 4. Wave 1 opened with seed_source.scoping_handoff carrying the blueprint.
      const wave1 = await getOpenWaveByCourse(courseId);
      expect(wave1).not.toBeNull();
      expect(wave1?.waveNumber).toBe(1);
      expect(wave1?.tier).toBe(2);
      expect(wave1?.seedSource).toMatchObject({
        kind: "scoping_handoff",
        blueprint: {
          topic: "Ownership basics",
          openingText: "Welcome to lesson 1.",
        },
      });

      // 5. Single assistant context_messages row at turnIndex=0/seq=0 carrying
      //    the blueprint's openingText.
      const wave1Messages = await getMessagesForWave(wave1!.id);
      expect(wave1Messages).toHaveLength(1);
      expect(wave1Messages[0]).toMatchObject({
        role: "assistant",
        kind: "assistant_response",
        content: "Welcome to lesson 1.",
        turnIndex: 0,
        seq: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Rollback path: pre-existing open Wave 1 forces `openWave` to throw via
  // the partial unique index `waves_one_open_per_course`. The transaction
  // rolls back the `tx.execute` writes (baseline JSONB stays untouched and
  // course stays in scoping). MVP CAVEAT: the helpers that use the top-level
  // `db` singleton (`upsertConcept`) are NOT covered by the transaction;
  // see `persistScopingClose` docstring. We assert what IS truly transactional.
  // -------------------------------------------------------------------------
  it("rolls back the baseline JSONB widen + status flip when Wave 1 insert fails", async () => {
    await seedScopingCourseAndRun(async (courseId) => {
      // Pre-create an open Wave 1 so the partial unique index rejects the
      // second insert inside persistScopingClose.
      await openWave({
        courseId,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: FRAMEWORK,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: [],
        seedSource: {
          kind: "scoping_handoff",
          blueprint: {
            topic: "pre-existing",
            outline: ["x"],
            openingText: "pre-existing opening",
          },
        },
        turnBudget: 10,
      });

      // The call must throw — postgres raises a unique-violation, which
      // bubbles through `openWave` into `db.transaction` triggering rollback.
      await expect(
        persistScopingClose({ courseId, parsed: PARSED, merged: MERGED }),
      ).rejects.toThrow();

      // Course still in scoping; baseline JSONB widen was rolled back.
      const after = await getCourseById(courseId);
      expect(after.status).toBe("scoping");
      expect(after.totalXp).toBe(0);
      expect(after.startingTier).toBeNull();
      // The widened payload includes `immutableSummary`; pre-close shape does NOT.
      // After rollback, baseline JSONB must NOT contain that key.
      expect(after.baseline).not.toHaveProperty("immutableSummary");

      // Only the pre-existing Wave 1 row should be present — no extras from
      // a partial run. The pre-existing wave has the "pre-existing" topic.
      const wave1 = await getOpenWaveByCourse(courseId);
      expect(wave1).not.toBeNull();
      expect(wave1?.seedSource).toMatchObject({
        kind: "scoping_handoff",
        blueprint: { topic: "pre-existing" },
      });
    });
  });
});
