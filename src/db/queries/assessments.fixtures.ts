/**
 * Shared fixtures for the `assessments` integration tests (reads, record,
 * open). Seeds the FK chain each suite needs.
 *
 * Test-only module: never imported by production code.
 */

import { WAVE as WAVE_CONFIG } from "@/lib/config/tuning";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses, waves, concepts } from "@/db/schema";

/** Fixed UUIDs per plan §D9. */
const USER = "77777777-7777-7777-7777-777777777777";
const COURSE = "00000000-0000-0000-0000-000000000701";
export const WAVE = "00000000-0000-0000-0000-000000000702";
export const CONCEPT = "00000000-0000-0000-0000-000000000703";
/** A second course + its concept — used for cross-course pollution tests. */
const COURSE_B = "00000000-0000-0000-0000-000000000704";
export const CONCEPT_B = "00000000-0000-0000-0000-000000000705";

/**
 * Minimal valid `frameworkSnapshot` — must satisfy `frameworkJsonbSchema`.
 * Matches the pattern established in contextMessages and concepts tests.
 */
const FRAMEWORK_SNAPSHOT = {
  topic: "x",
  scope_summary: "y",
  estimated_starting_tier: 1,
  baseline_scope_tiers: [1],
  tiers: [{ number: 1, name: "n", description: "d", example_concepts: ["e"] }],
} as const;

/**
 * Seed the full FK chain (userProfiles → courses → waves → concepts) into the
 * active test transaction. Must be called inside a `withTestDb` callback
 * because `withTestDb` truncates before each invocation.
 *
 * Optionally seeds a second course (COURSE_B) with one concept (CONCEPT_B) but
 * no wave — used for cross-course pollution tests.
 */
export async function seedFixtures(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  { withCourseB = false }: { withCourseB?: boolean } = {},
): Promise<void> {
  await db.insert(userProfiles).values({ id: USER, displayName: "U" });
  await db.insert(courses).values({ id: COURSE, userId: USER, topic: "x" });
  await db.insert(waves).values({
    id: WAVE,
    courseId: COURSE,
    waveNumber: 1,
    tier: 1,
    frameworkSnapshot: FRAMEWORK_SNAPSHOT,
    customInstructionsSnapshot: null,
    dueConceptsSnapshot: [],
    seedSource: { kind: "scoping_handoff" },
    turnBudget: WAVE_CONFIG.turnCount,
  });
  await db.insert(concepts).values({ id: CONCEPT, courseId: COURSE, name: "x", tier: 1 });

  if (withCourseB) {
    // Second course owned by the same user; CONCEPT_B belongs to COURSE_B (not COURSE).
    // Used to verify that recording an assessment for WAVE (course A) with
    // CONCEPT_B (course B) throws a cross-course error.
    await db.insert(courses).values({ id: COURSE_B, userId: USER, topic: "y" });
    await db.insert(concepts).values({ id: CONCEPT_B, courseId: COURSE_B, name: "y", tier: 1 });
  }
}
