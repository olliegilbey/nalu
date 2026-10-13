import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses } from "@/db/schema";
import { upsertConcept, updateConceptSm2 } from "./concepts.writes";
import { getDueConceptsByCourse } from "./concepts";

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
  // Test 3b: `limit` caps in SQL and keeps most-overdue-first order (issue #62)
  // ---------------------------------------------------------------------------
  it("getDueConceptsByCourse applies limit after the most-overdue-first order", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
      // Three due concepts, inserted least overdue first so insertion order
      // cannot pass for the ORDER BY.
      const seeded = [
        { name: "one-day", dueAt: daysAgo(1) },
        { name: "three-days", dueAt: daysAgo(3) },
        { name: "two-days", dueAt: daysAgo(2) },
      ];
      for (const { name, dueAt } of seeded) {
        const c = await upsertConcept({ courseId: COURSE, name, tier: 1 });
        await updateConceptSm2(c.id, {
          easinessFactor: 2.5,
          intervalDays: 1,
          repetitionCount: 1,
          lastQualityScore: 3,
          lastReviewedAt: dueAt,
          nextReviewAt: dueAt,
        });
      }

      const capped = await getDueConceptsByCourse(COURSE, new Date(), 2);
      expect(capped.map((c) => c.name)).toEqual(["three-days", "two-days"]);
      // No limit: the full due list.
      expect(await getDueConceptsByCourse(COURSE, new Date())).toHaveLength(3);
    });
  });
});
