import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { upsertConcept, getConceptByNameForCourse } from "@/db/queries/concepts";
import { calculateSM2 } from "@/lib/spaced-repetition/sm2";
import { applySm2Update } from "./applySm2Update";

/**
 * Integration tests for `applySm2Update`.
 *
 * Verifies the close-only SM-2 step:
 *  (a) writes the correct next-state derived from `calculateSM2`
 *  (b) throws when the concept name doesn't exist on the course
 *  (c) `now` flows through to both `lastReviewedAt` and `nextReviewAt`
 *
 * `now` is injected as a fixed Date for determinism — the same Date object
 * the test uses to compute the expected `calculateSM2` result is passed into
 * the function under test, so floating-point intervals match exactly.
 */

const USER_ID = "77777777-7777-7777-7777-777777777777";

/** Seed a user + course + one concept at SM-2 defaults (never reviewed). */
async function seedCourseWithConcept(name: string, tier: number): Promise<string> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  await upsertConcept({ courseId: course.id, name, tier });
  return course.id;
}

describe("applySm2Update (integration)", () => {
  it("writes the SM-2 next-state computed by calculateSM2 for a fresh concept", async () => {
    await withTestDb(async () => {
      const courseId = await seedCourseWithConcept("ownership", 2);
      // Capture pre-state so we can compute the expected next-state with the
      // SAME inputs the function-under-test will use.
      const before = await getConceptByNameForCourse(courseId, "ownership");
      expect(before).not.toBeNull();
      const now = new Date("2026-05-18T12:00:00.000Z");
      const quality = 5;
      const expected = calculateSM2(
        {
          easinessFactor: before!.easinessFactor,
          interval: before!.intervalDays,
          repetitionCount: before!.repetitionCount,
        },
        quality,
        now,
      );

      await applySm2Update({
        courseId,
        name: "ownership",
        qualityScore: quality,
        now,
        tx: db,
      });

      const after = await getConceptByNameForCourse(courseId, "ownership");
      expect(after).not.toBeNull();
      // SM-2 state matches the pure-function result exactly.
      expect(after!.easinessFactor).toBeCloseTo(expected.easinessFactor, 6);
      expect(after!.intervalDays).toBe(expected.interval);
      expect(after!.repetitionCount).toBe(expected.repetitionCount);
      expect(after!.lastQualityScore).toBe(quality);
      // `now` flows through to both review timestamps verbatim.
      expect(after!.lastReviewedAt?.toISOString()).toBe(now.toISOString());
      expect(after!.nextReviewAt?.toISOString()).toBe(expected.nextReviewAt.toISOString());
    });
  });

  it("throws when the concept name is missing on the course", async () => {
    await withTestDb(async () => {
      const courseId = await seedCourseWithConcept("ownership", 2);
      const now = new Date("2026-05-18T12:00:00.000Z");

      await expect(
        applySm2Update({
          courseId,
          // Name not seeded — getConceptByNameForCourse returns null and the
          // helper raises a typed error mentioning concept + course.
          name: "borrowing",
          qualityScore: 4,
          now,
          tx: db,
        }),
      ).rejects.toThrow(/concept 'borrowing' missing/);
    });
  });

  it("name lookup is case-insensitive (matches the lower(name) unique index)", async () => {
    await withTestDb(async () => {
      const courseId = await seedCourseWithConcept("Ownership", 2);
      const now = new Date("2026-05-18T12:00:00.000Z");

      // Lower-cased name still resolves to the same row.
      await applySm2Update({
        courseId,
        name: "ownership",
        qualityScore: 5,
        now,
        tx: db,
      });

      const after = await getConceptByNameForCourse(courseId, "Ownership");
      expect(after?.lastQualityScore).toBe(5);
      expect(after?.lastReviewedAt?.toISOString()).toBe(now.toISOString());
    });
  });
});
