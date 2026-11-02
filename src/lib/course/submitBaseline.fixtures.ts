/**
 * Shared fixtures and helpers for the `submitBaseline` integration tests.
 *
 * Extracted to keep both `submitBaseline.persist.test.ts` (happy + rollback)
 * under the 200-LOC ceiling. Lives next to the suites in `src/lib/course/`
 * because these fixtures are tightly coupled to the persist transaction's
 * shapes — they aren't general test infrastructure.
 *
 * Test-only module: never imported by production code.
 */

import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { updateCourseScopingState } from "@/db/queries/courses.scoping";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import type { CloseTurnBase } from "@/lib/prompts/closeTurn";
import type { ScoreBaselineResult } from "@/lib/scoring/scoreBaseline";

/** Fixed UUID for the test user — avoids runtime UUID generation. */
export const USER_ID = "55555555-5555-5555-5555-555555555555";

/** Minimal valid framework matching `frameworkJsonbSchema`. */
export const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["b"] },
  ],
} as const;

/**
 * Minimal valid baseline (pre-close shape) with one free-text question at
 * tier 1. Answered correctly, it masters tier 1, and tier 2 has no
 * questions, so placement starts the learner at tier 2 (`MERGED`).
 */
export const BASELINE_PRECLOSE = {
  userMessage: "baseline framing",
  questions: [
    {
      id: "b1",
      type: "free_text" as const,
      prompt: "What is ownership?",
      freetextRubric: "rubric",
      conceptName: "ownership",
      tier: 1,
    },
  ],
  responses: [{ questionId: "b1", freetext: "the rule about owning values" }],
  gradings: [],
} as const;

/**
 * Minimal valid parsed close-turn payload (post-Zod).
 *
 * Plain (non-`as const`) object so `gradings` is a mutable array — matches
 * the inferred `CloseTurnBase` shape. The scoping close emits the shared
 * close-turn base and nothing more: placement is the Harness's (issue #94).
 */
export const PARSED: CloseTurnBase = {
  userMessage: "closing chat message",
  summary: "evolving seed",
  // persistScopingClose only consumes `merged.gradings`, not parsed.gradings.
  // `submitBaseline` merges these into `merged`.
  gradings: [
    {
      kind: "free-text",
      questionId: "b1",
      conceptName: "ownership",
      conceptTier: 1,
      verdict: "correct",
      qualityScore: 5,
      rationale: "good",
    },
  ],
  nextUnitBlueprint: {
    topic: "Ownership basics",
    outline: ["intro", "examples"],
    openingText: "Welcome to lesson 1.",
    plannedConcepts: [],
  },
};

/**
 * Canonical-ordered gradings, starting tier + deterministic XP from
 * `scoreBaseline`. `startingTier` matches what placement computes for
 * `PARSED` on `BASELINE_PRECLOSE`.
 */
export const MERGED: ScoreBaselineResult = {
  gradings: [
    {
      questionId: "b1",
      conceptName: "ownership",
      conceptTier: 1,
      verdict: "correct",
      qualityScore: 5,
      rationale: "good",
    },
  ],
  startingTier: 2,
  // What `scoreBaseline` computes: one q5 grading at tier 2 is 2×10×1.5.
  totalXp: 30,
};

/**
 * Seed user, create a course in scoping with framework + baseline already
 * populated and its scoping pass open, then run the test body against the
 * same `withTestDb` instance.
 */
export async function seedScopingCourseAndRun(
  fn: (courseId: string, scopingPassId: string) => Promise<void>,
): Promise<void> {
  return withTestDb(async (db) => {
    await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
    const course = await createCourse({ userId: USER_ID, topic: "Rust" });
    await updateCourseScopingState(course.id, {
      framework: FRAMEWORK,
      baseline: BASELINE_PRECLOSE,
    });
    const pass = await ensureOpenScopingPass(course.id);
    await fn(course.id, pass.id);
  });
}

/** Full AI SDK v5 `LanguageModelUsage` zero shape for executeTurn mocks. */
export const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/**
 * Seed user, course in scoping with framework + baseline populated, and an
 * open scoping pass (so `executeTurn`'s parent FK has somewhere to land
 * before it's mocked out). Returns the course id for the test body.
 *
 * Caller must already be inside `withTestDb` (uses the imported db singleton
 * directly rather than receiving it via callback).
 */
export async function seedScopingCourse(): Promise<string> {
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
