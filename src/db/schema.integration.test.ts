import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import {
  userProfiles,
  courses,
  scopingPasses,
  waves,
  contextMessages,
  concepts,
  assessments,
} from "@/db/schema";

/**
 * Locks the runtime behavior of every non-trivial schema constraint defined
 * in B1–B9: CHECK enums, the polymorphic XOR on `context_messages`, partial
 * unique indexes (one-open-per-course, per-parent message ordering), and the
 * case-insensitive functional unique on `concepts`. Plain NOT NULL / FK
 * cascade behavior is covered transitively by drizzle-zod + the migration
 * smoke; this file targets the bits where the docstrings make a promise the
 * generated SQL has to keep.
 *
 * Postgres error codes used:
 *   23505 = unique_violation
 *   23514 = check_violation
 */

const USER_ID = "00000000-0000-0000-0000-0000000000aa";

/** Insert a user + course and return the course id; used by most tests. */
async function seedCourse(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  topic = "Topic",
): Promise<string> {
  await db
    .insert(userProfiles)
    .values({ id: USER_ID, displayName: "U" })
    .onConflictDoNothing({ target: userProfiles.id });
  const [row] = await db.insert(courses).values({ userId: USER_ID, topic }).returning();
  if (!row) throw new Error("course insert returned no row");
  return row.id;
}

describe("courses constraints", () => {
  it("rejects status outside the allowed enum", async () => {
    await withTestDb(async (db) => {
      await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
      await expect(
        db.insert(courses).values({ userId: USER_ID, topic: "T", status: "bogus" }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });
});

describe("scoping_passes constraints", () => {
  it("rejects a second pass for the same course (one-per-course unique)", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourse(db);
      await db.insert(scopingPasses).values({ courseId });
      await expect(db.insert(scopingPasses).values({ courseId })).rejects.toMatchObject({
        cause: { code: "23505" },
      });
    });
  });

  it("rejects status outside the allowed enum", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourse(db);
      await expect(
        db.insert(scopingPasses).values({ courseId, status: "halfway" }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });
});

describe("waves constraints", () => {
  const waveBase = (courseId: string, waveNumber: number) => ({
    courseId,
    waveNumber,
    tier: 1,
    frameworkSnapshot: {},
    dueConceptsSnapshot: [],
    seedSource: { kind: "scoping_handoff" },
    turnBudget: 10,
  });

  it("rejects duplicate (course_id, wave_number)", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourse(db);
      await db.insert(waves).values(waveBase(courseId, 1));
      await expect(db.insert(waves).values(waveBase(courseId, 1))).rejects.toMatchObject({
        cause: { code: "23505" },
      });
    });
  });

  it("rejects a second open wave on the same course (partial unique)", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourse(db);
      await db.insert(waves).values(waveBase(courseId, 1));
      await expect(db.insert(waves).values(waveBase(courseId, 2))).rejects.toMatchObject({
        cause: { code: "23505" },
      });
    });
  });

  it("allows a new open wave once the prior one is closed", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourse(db);
      const [first] = await db.insert(waves).values(waveBase(courseId, 1)).returning();
      if (!first) throw new Error("missing wave row");
      // Raw SQL avoids drizzle's update().set() — `.set()` trips eslint-plugin-functional's
      // immutable-data rule, which lacks parserOptions for typed linting in this repo.
      // The actual DB write is identical.
      await db.execute(sql`UPDATE waves SET status = 'closed' WHERE id = ${first.id}`);
      // Second open wave is now permissible — partial filter only sees one open row.
      await db.insert(waves).values(waveBase(courseId, 2));
      const open = await db.select().from(waves).where(eq(waves.status, "open"));
      expect(open).toHaveLength(1);
    });
  });

  it("rejects status outside the allowed enum", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourse(db);
      await expect(
        db.insert(waves).values({ ...waveBase(courseId, 1), status: "paused" }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });
});

describe("context_messages constraints", () => {
  const seedWave = async (db: Parameters<Parameters<typeof withTestDb>[0]>[0]): Promise<string> => {
    const courseId = await seedCourse(db);
    const [w] = await db
      .insert(waves)
      .values({
        courseId,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: {},
        dueConceptsSnapshot: [],
        seedSource: { kind: "scoping_handoff" },
        turnBudget: 10,
      })
      .returning();
    if (!w) throw new Error("missing wave row");
    return w.id;
  };

  it("rejects a row with both parent ids set (XOR violation)", async () => {
    await withTestDb(async (db) => {
      const waveId = await seedWave(db);
      const courseId = await seedCourse(db);
      const [pass] = await db.insert(scopingPasses).values({ courseId }).returning();
      if (!pass) throw new Error("missing pass row");
      await expect(
        db.insert(contextMessages).values({
          waveId,
          scopingPassId: pass.id,
          turnIndex: 0,
          seq: 0,
          kind: "user_message",
          role: "user",
          content: "hi",
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  it("rejects a row with neither parent id set (XOR violation)", async () => {
    await withTestDb(async (db) => {
      await expect(
        db.insert(contextMessages).values({
          turnIndex: 0,
          seq: 0,
          kind: "user_message",
          role: "user",
          content: "hi",
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  it("rejects an unknown kind", async () => {
    await withTestDb(async (db) => {
      const waveId = await seedWave(db);
      await expect(
        db.insert(contextMessages).values({
          waveId,
          turnIndex: 0,
          seq: 0,
          kind: "mystery",
          role: "user",
          content: "hi",
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  it("rejects role 'system' (system content is never persisted)", async () => {
    await withTestDb(async (db) => {
      const waveId = await seedWave(db);
      await expect(
        db.insert(contextMessages).values({
          waveId,
          turnIndex: 0,
          seq: 0,
          kind: "user_message",
          role: "system",
          content: "hi",
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  it("rejects duplicate (wave_id, turn_index, seq) — partial wave-order unique", async () => {
    await withTestDb(async (db) => {
      const waveId = await seedWave(db);
      const row = {
        waveId,
        turnIndex: 0,
        seq: 0,
        kind: "user_message" as const,
        role: "user" as const,
        content: "hi",
      };
      await db.insert(contextMessages).values(row);
      await expect(db.insert(contextMessages).values(row)).rejects.toMatchObject({
        cause: { code: "23505" },
      });
    });
  });
});

describe("concepts constraints", () => {
  it("rejects same name in same course differing only by case (functional unique on lower(name))", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourse(db);
      await db.insert(concepts).values({ courseId, name: "JavaScript", tier: 1 });
      await expect(
        db.insert(concepts).values({ courseId, name: "javascript", tier: 1 }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });
  });

  it("allows the same name across different courses", async () => {
    await withTestDb(async (db) => {
      const courseA = await seedCourse(db, "A");
      const courseB = await seedCourse(db, "B");
      await db.insert(concepts).values({ courseId: courseA, name: "Closures", tier: 1 });
      await db.insert(concepts).values({ courseId: courseB, name: "closures", tier: 1 });
      const rows = await db.select().from(concepts);
      expect(rows).toHaveLength(2);
    });
  });
});

describe("assessments constraints", () => {
  const seed = async (
    db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  ): Promise<{ waveId: string; conceptId: string }> => {
    const courseId = await seedCourse(db);
    const [w] = await db
      .insert(waves)
      .values({
        courseId,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: {},
        dueConceptsSnapshot: [],
        seedSource: { kind: "scoping_handoff" },
        turnBudget: 10,
      })
      .returning();
    const [c] = await db.insert(concepts).values({ courseId, name: "X", tier: 1 }).returning();
    if (!w || !c) throw new Error("missing fixture row");
    return { waveId: w.id, conceptId: c.id };
  };

  it("rejects an unknown assessment kind", async () => {
    await withTestDb(async (db) => {
      const { waveId, conceptId } = await seed(db);
      await expect(
        db.insert(assessments).values({
          waveId,
          conceptId,
          turnIndex: 0,
          userAnswer: "ans",
          isCorrect: true,
          qualityScore: 5,
          assessmentKind: "essay",
          question: "q",
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  it("rejects card_mc with null question (conditional CHECK)", async () => {
    await withTestDb(async (db) => {
      const { waveId, conceptId } = await seed(db);
      await expect(
        db.insert(assessments).values({
          waveId,
          conceptId,
          turnIndex: 0,
          userAnswer: "ans",
          isCorrect: true,
          qualityScore: 5,
          assessmentKind: "card_mc",
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  it("accepts inferred with null question", async () => {
    await withTestDb(async (db) => {
      const { waveId, conceptId } = await seed(db);
      await db.insert(assessments).values({
        waveId,
        conceptId,
        turnIndex: 0,
        userAnswer: "their prior message text",
        isCorrect: true,
        qualityScore: 4,
        assessmentKind: "inferred",
      });
      const rows = await db.select().from(assessments);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.question).toBeNull();
    });
  });
});
