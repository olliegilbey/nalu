import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses, concepts as conceptsTable } from "@/db/schema";
import { SM2 } from "@/lib/config/tuning";
import { upsertConcept, updateConceptSm2, type Sm2Update } from "./concepts.writes";

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

describe("concepts writes", () => {
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

/** An SM-2 write that differs only in its easiness factor. */
function sm2WithEasinessFactor(easinessFactor: number): Sm2Update {
  const now = new Date();
  return {
    easinessFactor,
    intervalDays: 1,
    repetitionCount: 0,
    lastQualityScore: 1,
    lastReviewedAt: now,
    nextReviewAt: now,
  };
}

// The CHECK `concepts_easiness_factor_min` against the floor that sm2.ts
// clamps to (issue #210). `easiness_factor` is `real`, and real 1.3 is
// 1.29999995. Compared as float8, the floor itself failed the CHECK, so two
// failed reviews from 2.5 (→ 1.7 → 1.3) broke the Wave close.
describe("updateConceptSm2 at the easiness-factor floor", () => {
  it("accepts EF exactly at SM2.easinessFactorFloor", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);
      const concept = await upsertConcept({ courseId: COURSE, name: "Floor", tier: 1 });

      const updated = await updateConceptSm2(
        concept.id,
        sm2WithEasinessFactor(SM2.easinessFactorFloor),
      );

      // Read back at real precision: 1.3 returns as 1.2999999523…
      expect(updated.easinessFactor).toBeCloseTo(SM2.easinessFactorFloor, 5);
    });
  });

  it("rejects EF just below SM2.easinessFactorFloor", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);
      const concept = await upsertConcept({ courseId: COURSE, name: "Below", tier: 1 });

      await expect(
        updateConceptSm2(concept.id, sm2WithEasinessFactor(SM2.easinessFactorFloor - 0.0001)),
      ).rejects.toMatchObject({
        cause: { code: "23514", constraint_name: "concepts_easiness_factor_min" },
      });
    });
  });
});
