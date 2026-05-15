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
import { createCourse, updateCourseScopingState } from "@/db/queries/courses";
import type { ScopingCloseTurn } from "@/lib/prompts/scopingClose";
import type { MergeAndComputeXpResult } from "./submitBaseline.merge";

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

/** Minimal valid baseline (pre-close shape) with one free-text question. */
export const BASELINE_PRECLOSE = {
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
 */
export const PARSED: ScopingCloseTurn = {
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
export const MERGED: MergeAndComputeXpResult = {
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
export async function seedScopingCourseAndRun(
  fn: (courseId: string) => Promise<void>,
): Promise<void> {
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
