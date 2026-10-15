import { describe, it, expect, expectTypeOf } from "vitest";
import { eq, sql } from "drizzle-orm";
import { WAVE } from "@/lib/config/tuning";
import { withTestDb } from "@/db/testing/withTestDb";
import type { AppendMessageParams } from "@/db/queries/contextMessages";
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
 * in B1–B9: CHECK enums, the polymorphic XOR and kind/role pairing on
 * `context_messages`, partial unique indexes (one-open-per-course,
 * per-parent message ordering), and the
 * case-insensitive functional unique on `concepts`. Plain NOT NULL / FK
 * cascade behavior is covered transitively by the migration
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
    turnBudget: WAVE.turnCount,
  });

  it("rejects a wave with non-positive tier (CHECK enforces invariant)", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourse(db);
      await expect(
        db.insert(waves).values({
          courseId,
          waveNumber: 1,
          tier: 0, // violates waves_tier_positive
          frameworkSnapshot: {} as never,
          dueConceptsSnapshot: [] as never,
          seedSource: { kind: "scoping_handoff" } as never,
          turnBudget: WAVE.turnCount,
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
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
      // Raw SQL UPDATE rather than drizzle's update().set() — house style for
      // updates (see src/db/queries/CLAUDE.md). The actual DB write is identical.
      // Must set closed_at alongside status='closed' to satisfy waves_closed_at_consistency.
      await db.execute(
        sql`UPDATE waves SET status = 'closed', closed_at = now() WHERE id = ${first.id}`,
      );
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
        turnBudget: WAVE.turnCount,
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

  it("rejects an unknown kind under kind_check", async () => {
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
      ).rejects.toMatchObject({
        // Postgres runs CHECKs in name order; kind_check sorts before kind_role_pair.
        cause: { code: "23514", constraint_name: "context_messages_kind_check" },
      });
    });
  });

  it("accepts failed_assistant_response and harness_retry_directive kinds", async () => {
    // Both kinds are persisted by the per-turn retry loop in executeTurn:
    //  - failed_assistant_response: raw model output that didn't parse (role=assistant)
    //  - harness_retry_directive: synthesised nudge telling the model to try again (role=user)
    // They share (wave_id, turn_index) with the original failed attempt; seq disambiguates.
    await withTestDb(async (db) => {
      const waveId = await seedWave(db);
      await db.insert(contextMessages).values({
        waveId,
        turnIndex: 0,
        seq: 0,
        kind: "failed_assistant_response",
        role: "assistant",
        content: "<response>oops",
      });
      await db.insert(contextMessages).values({
        waveId,
        turnIndex: 0,
        seq: 1,
        kind: "harness_retry_directive",
        role: "user",
        content: "your last response was missing a closing tag; please retry",
      });
      const rows = await db
        .select()
        .from(contextMessages)
        .where(eq(contextMessages.waveId, waveId));
      expect(rows).toHaveLength(2);
    });
  });

  // The legal kind→role table, written out independently of the schema so
  // the test fails if the CHECK drifts. Writers: src/lib/turn/ (every turn
  // row) and the close transactions (turn-0 assistant_response). The three
  // unwritten kinds (card_answer, harness_turn_counter, harness_review_block)
  // are user-role per spec §6.5: learner input or Harness injections.
  const ROLE_BY_KIND = {
    user_message: "user",
    card_answer: "user",
    harness_turn_counter: "user",
    harness_review_block: "user",
    harness_retry_directive: "user",
    assistant_response: "assistant",
    failed_assistant_response: "assistant",
    assistant_tool_call: "assistant",
    tool_result: "tool",
  } as const;
  // The three legal roles, plus 'system' (never persisted, P3) and an unknown role.
  const ROLES = ["user", "assistant", "tool", "system", "narrator"] as const;
  // Every (kind, role) combination the role table forbids: 9 kinds × 5 roles − 9 legal = 36.
  const MISMATCHED_PAIRS = Object.entries(ROLE_BY_KIND).flatMap(([kind, legalRole]) =>
    ROLES.filter((role) => role !== legalRole).map((role) => ({ kind, role })),
  );

  it("accepts every legal kind/role pair", async () => {
    await withTestDb(async (db) => {
      const waveId = await seedWave(db);
      // One row per kind; seq keeps them clear of the (wave, turn, seq) unique.
      await db.insert(contextMessages).values(
        Object.entries(ROLE_BY_KIND).map(([kind, role], seq) => ({
          waveId,
          turnIndex: 0,
          seq,
          kind,
          role,
          content: "x",
        })),
      );
      const rows = await db
        .select()
        .from(contextMessages)
        .where(eq(contextMessages.waveId, waveId));
      expect(rows).toHaveLength(Object.keys(ROLE_BY_KIND).length);
    });
  });

  it.each(MISMATCHED_PAIRS)("rejects kind $kind with role $role", async ({ kind, role }) => {
    await withTestDb(async (db) => {
      const waveId = await seedWave(db);
      await expect(
        db
          .insert(contextMessages)
          .values({ waveId, turnIndex: 0, seq: 0, kind, role, content: "x" }),
      ).rejects.toMatchObject({
        // Every kind here is legal, so kind_check passes; the pair CHECK owns every role failure.
        cause: { code: "23514", constraint_name: "context_messages_kind_role_pair" },
      });
    });
  });

  // Type-level: tsc checks this, vitest runs it as a no-op. The query layer's
  // AppendMessageParams admits exactly the table's pairs, so a writer cannot
  // compile a pair the CHECK rejects (#108).
  it("types AppendMessageParams with exactly the legal kind/role pairs", () => {
    type LegalPair = {
      [K in keyof typeof ROLE_BY_KIND]: {
        readonly kind: K;
        readonly role: (typeof ROLE_BY_KIND)[K];
      };
    }[keyof typeof ROLE_BY_KIND];
    // Distributes over a union: one { kind, role } per variant.
    type KindRoleOf<T> = T extends { readonly kind: infer K; readonly role: infer R }
      ? { readonly kind: K; readonly role: R }
      : never;
    expectTypeOf<KindRoleOf<AppendMessageParams>>().toEqualTypeOf<LegalPair>();
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
        turnBudget: WAVE.turnCount,
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
