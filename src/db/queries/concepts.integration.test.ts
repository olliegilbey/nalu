import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses, concepts as conceptsTable } from "@/db/schema";
import {
  upsertConcept,
  getConceptById,
  getDueConceptsByCourse,
  updateConceptSm2,
  incrementCorrect,
  incrementIncorrect,
} from "./concepts";

/** Fixed UUIDs per plan §D8. */
const USER = "66666666-6666-6666-6666-666666666666";
const COURSE = "00000000-0000-0000-0000-000000000601";

/**
 * Seed the standard fixtures (user + course) into the active test transaction.
 * Must be called inside a `withTestDb` callback because `withTestDb` truncates
 * before each invocation — seeding outside would be wiped.
 */
async function seedFixtures(db: Parameters<Parameters<typeof withTestDb>[0]>[0]): Promise<void> {
  await db.insert(userProfiles).values({ id: USER, displayName: "U" });
  await db.insert(courses).values({ id: COURSE, userId: USER, topic: "Rust" });
}

describe("concepts queries", () => {
  // ---------------------------------------------------------------------------
  // Test 1: upsertConcept dedupes case-insensitively
  // ---------------------------------------------------------------------------
  it("upsertConcept dedupes case-insensitively", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // First insert creates the row.
      const a = await upsertConcept({ courseId: COURSE, name: "Move Semantics", tier: 1 });
      // Second insert with different casing must resolve to the same row.
      const b = await upsertConcept({ courseId: COURSE, name: "move semantics", tier: 1 });

      expect(b.id).toBe(a.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: upsertConcept does NOT overwrite tier on conflict
  // ---------------------------------------------------------------------------
  it("upsertConcept does NOT overwrite tier on conflict", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // First insert with tier=1.
      const a = await upsertConcept({ courseId: COURSE, name: "X", tier: 1 });
      // Conflict with tier=5: the existing tier=1 must be preserved.
      const b = await upsertConcept({ courseId: COURSE, name: "x", tier: 5 });

      expect(b.id).toBe(a.id);
      expect(b.tier).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: getDueConceptsByCourse returns only concepts with next_review_at <= now
  // ---------------------------------------------------------------------------
  it("getDueConceptsByCourse uses next_review_at <= now()", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // Concept "due" — next_review_at is in the past.
      const a = await upsertConcept({ courseId: COURSE, name: "due", tier: 1 });
      // Concept "later" — next_review_at is in the future.
      const b = await upsertConcept({ courseId: COURSE, name: "later", tier: 1 });

      await updateConceptSm2(a.id, {
        easinessFactor: 2.5,
        intervalDays: 1,
        repetitionCount: 1,
        lastQualityScore: 4,
        lastReviewedAt: past,
        nextReviewAt: past,
      });
      await updateConceptSm2(b.id, {
        easinessFactor: 2.5,
        intervalDays: 1,
        repetitionCount: 1,
        lastQualityScore: 4,
        lastReviewedAt: past,
        nextReviewAt: future,
      });

      const due = await getDueConceptsByCourse(COURSE, new Date());

      // Only the past-due concept should appear.
      expect(due.map((c) => c.id)).toEqual([a.id]);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: incrementCorrect / incrementIncorrect bump counters
  // ---------------------------------------------------------------------------
  it("incrementCorrect / incrementIncorrect bump counters", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      const c = await upsertConcept({ courseId: COURSE, name: "y", tier: 1 });

      // Two correct, one incorrect.
      await incrementCorrect(c.id);
      await incrementIncorrect(c.id);
      await incrementCorrect(c.id);

      // Re-fetch via getConceptById to verify persisted counts.
      const row = await getConceptById(c.id);
      expect(row.timesCorrect).toBe(2);
      expect(row.timesIncorrect).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5: upsertConcept DO NOTHING — same name different case = one row
  //
  // Verifies the switch from `DO UPDATE SET name = EXCLUDED.name` to `DO NOTHING`.
  // Both inserts must return the same row id, and only one physical row should
  // exist in the DB (checked via a raw COUNT query).
  // ---------------------------------------------------------------------------
  it("upsertConcept DO NOTHING: same-name-different-case inserts exactly one row", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // First insert creates the row.
      const first = await upsertConcept({ courseId: COURSE, name: "Pythagoras", tier: 2 });
      // Second insert with a different casing — must hit the conflict path and
      // return the original row unchanged (id and tier are preserved).
      const second = await upsertConcept({ courseId: COURSE, name: "PYTHAGORAS", tier: 99 });

      // Both calls return the same row.
      expect(second.id).toBe(first.id);
      // Tier from the second call must NOT overwrite the original tier=2.
      expect(second.tier).toBe(2);

      // Verify at the DB level: only one row for this name in the course.
      // This is the definitive check that DO NOTHING did not insert a second row.
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(conceptsTable)
        .where(
          sql`lower(${conceptsTable.name}) = lower('Pythagoras') AND ${conceptsTable.courseId} = ${COURSE}`,
        );
      expect(countRow?.count).toBe(1);
    });
  });
});
