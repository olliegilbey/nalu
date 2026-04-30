import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses } from "@/db/schema";
import { NotFoundError } from "./errors";
import {
  openWave,
  getOpenWaveByCourse,
  getWaveById,
  closeWave,
  listClosedWavesByCourse,
  getLatestWaveNumberByCourse,
} from "./waves";

/** Fixed UUIDs — avoids runtime UUID generation. */
const USER_ID = "44444444-4444-4444-4444-444444444444";
const COURSE_ID = "00000000-0000-0000-0000-000000000401";

/** Minimal valid frameworkSnapshot matching frameworkJsonbSchema. */
const FRAMEWORK_SNAPSHOT = {
  topic: "Rust ownership",
  scope_summary: "Covers ownership, borrowing, lifetimes",
  estimated_starting_tier: 1,
  baseline_scope_tiers: [1, 2],
  tiers: [
    {
      number: 1,
      name: "Basics",
      description: "Variables and ownership",
      example_concepts: ["move"],
    },
    { number: 2, name: "Borrowing", description: "References", example_concepts: ["&T"] },
  ],
};

/** Minimal valid dueConceptsSnapshot (empty is valid). */
const DUE_CONCEPTS_SNAPSHOT = [] as const;

/** Minimal valid seedSource for Wave 1. */
const SEED_SOURCE_WAVE1 = { kind: "scoping_handoff" } as const;

/** Minimal valid Blueprint for closeWave. */
const BLUEPRINT = {
  topic: "Rust borrowing",
  outline: ["What is borrowing?", "Mutable vs immutable references"],
  openingText: "Let's dive into borrowing in Rust.",
};

/**
 * Seed the test user and course, then run `fn` inside the same `withTestDb` call.
 * `withTestDb` truncates all tables before running, so this seed must happen
 * inside the same call to avoid FK failures.
 */
async function seedAndRun<T>(
  fn: (db: Parameters<Parameters<typeof withTestDb>[0]>[0]) => Promise<T>,
): Promise<T> {
  return withTestDb(async (db) => {
    // Insert the parent user_profile and course rows needed for FK constraints.
    await db.insert(userProfiles).values({ id: USER_ID, displayName: "Test User" });
    await db.insert(courses).values({ id: COURSE_ID, userId: USER_ID, topic: "Rust ownership" });
    return fn(db);
  });
}

describe("waves queries", () => {
  // -------------------------------------------------------------------------
  // Test 1: openWave + getOpenWaveByCourse round-trip
  // -------------------------------------------------------------------------
  it("openWave + getOpenWaveByCourse round-trips wave fields", async () => {
    await seedAndRun(async () => {
      const wave = await openWave({
        courseId: COURSE_ID,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: FRAMEWORK_SNAPSHOT,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: DUE_CONCEPTS_SNAPSHOT,
        seedSource: SEED_SOURCE_WAVE1,
        turnBudget: 10,
      });

      // Returned row must reflect the inserted values.
      expect(wave.courseId).toBe(COURSE_ID);
      expect(wave.waveNumber).toBe(1);
      expect(wave.tier).toBe(1);
      expect(wave.status).toBe("open");
      expect(wave.blueprintEmitted).toBeNull();

      // getOpenWaveByCourse must return the same row.
      const found = await getOpenWaveByCourse(COURSE_ID);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(wave.id);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: partial unique index blocks two open waves on one course
  // -------------------------------------------------------------------------
  it("partial unique index blocks two open waves on the same course", async () => {
    await seedAndRun(async () => {
      // First wave — fine.
      await openWave({
        courseId: COURSE_ID,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: FRAMEWORK_SNAPSHOT,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: DUE_CONCEPTS_SNAPSHOT,
        seedSource: SEED_SOURCE_WAVE1,
        turnBudget: 10,
      });

      // Second open wave on same course — must be rejected by the DB constraint.
      await expect(
        openWave({
          courseId: COURSE_ID,
          waveNumber: 2,
          tier: 1,
          frameworkSnapshot: FRAMEWORK_SNAPSHOT,
          customInstructionsSnapshot: null,
          dueConceptsSnapshot: DUE_CONCEPTS_SNAPSHOT,
          seedSource: SEED_SOURCE_WAVE1,
          turnBudget: 10,
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: closeWave + listClosedWavesByCourse + getLatestWaveNumberByCourse
  // -------------------------------------------------------------------------
  it("closeWave permits opening the next wave; list and max wave number reflect state", async () => {
    await seedAndRun(async () => {
      // Open Wave 1.
      const wave1 = await openWave({
        courseId: COURSE_ID,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: FRAMEWORK_SNAPSHOT,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: DUE_CONCEPTS_SNAPSHOT,
        seedSource: SEED_SOURCE_WAVE1,
        turnBudget: 10,
      });

      // Close Wave 1.
      const closed = await closeWave(wave1.id, {
        summary: "Wave 1 done",
        blueprintEmitted: BLUEPRINT,
      });
      expect(closed.status).toBe("closed");
      expect(closed.summary).toBe("Wave 1 done");
      expect(closed.blueprintEmitted).toMatchObject({ topic: "Rust borrowing" });
      expect(closed.closedAt).not.toBeNull();

      // Now there is no open wave.
      const nowOpen = await getOpenWaveByCourse(COURSE_ID);
      expect(nowOpen).toBeNull();

      // Open Wave 2 — allowed because Wave 1 is now closed.
      const seedSource2 = {
        kind: "prior_blueprint" as const,
        priorWaveId: wave1.id,
        blueprint: BLUEPRINT,
      };
      await openWave({
        courseId: COURSE_ID,
        waveNumber: 2,
        tier: 1,
        frameworkSnapshot: FRAMEWORK_SNAPSHOT,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: DUE_CONCEPTS_SNAPSHOT,
        seedSource: seedSource2,
        turnBudget: 10,
      });

      // listClosedWavesByCourse must return exactly Wave 1.
      const closedWaves = await listClosedWavesByCourse(COURSE_ID);
      expect(closedWaves).toHaveLength(1);
      expect(closedWaves[0]?.waveNumber).toBe(1);

      // getLatestWaveNumberByCourse must return 2 (open Wave 2 is latest).
      const latestNum = await getLatestWaveNumberByCourse(COURSE_ID);
      expect(latestNum).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: getLatestWaveNumberByCourse returns 0 when no waves exist
  // -------------------------------------------------------------------------
  it("getLatestWaveNumberByCourse returns 0 when no waves exist", async () => {
    await seedAndRun(async () => {
      const num = await getLatestWaveNumberByCourse(COURSE_ID);
      expect(num).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: getWaveById throws NotFoundError for unknown id
  // -------------------------------------------------------------------------
  it("getWaveById throws NotFoundError for unknown id", async () => {
    await withTestDb(async () => {
      await expect(getWaveById("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: closeWave throws NotFoundError for unknown id
  // -------------------------------------------------------------------------
  it("closeWave throws NotFoundError for unknown id", async () => {
    await withTestDb(async () => {
      await expect(
        closeWave("00000000-0000-0000-0000-000000000000", {
          summary: "ghost",
          blueprintEmitted: BLUEPRINT,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // Test 7: closeWave is idempotent — closed_at sticks on second call
  // -------------------------------------------------------------------------
  it("closeWave is idempotent (closed_at sticks across repeat calls)", async () => {
    await seedAndRun(async () => {
      const wave = await openWave({
        courseId: COURSE_ID,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: FRAMEWORK_SNAPSHOT,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: DUE_CONCEPTS_SNAPSHOT,
        seedSource: SEED_SOURCE_WAVE1,
        turnBudget: 10,
      });

      const first = await closeWave(wave.id, { summary: "first", blueprintEmitted: BLUEPRINT });
      const second = await closeWave(wave.id, { summary: "second", blueprintEmitted: BLUEPRINT });

      // COALESCE keeps closed_at sticky — second call must not re-stamp.
      expect(first.closedAt).toEqual(second.closedAt);
      // Status is 'closed' on both returns.
      expect(first.status).toBe("closed");
      expect(second.status).toBe("closed");
      // The summary is NOT updated on the second call because the WHERE status='open'
      // clause makes the UPDATE a no-op — we verify the original value persists.
      expect(second.summary).toBe("first");
    });
  });
});
