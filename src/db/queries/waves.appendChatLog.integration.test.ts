import { describe, it, expect } from "vitest";
import { WAVE } from "@/lib/config/tuning";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses } from "@/db/schema";
import { openWave, getWaveById, appendWaveChatLog } from "./waves";

/**
 * Integration coverage for `appendWaveChatLog` — Task 4 of the wave chat_log
 * mirror-scoping refactor. The query is an atomic JSONB `||` concat over a
 * row's existing `chat_log` array, so the three things we verify are:
 *
 *  1. Single append turns the default empty array into a one-entry log.
 *  2. Multiple sequential appends preserve insertion order (the `||` operator
 *     concatenates right-onto-left in invocation order).
 *  3. A caller-supplied transaction wraps the append so the row is unchanged
 *     when the tx rolls back — required for `executeWaveMid` and friends to
 *     keep chat-log writes atomic with sibling inserts (assessments,
 *     context_messages) inside the same tx.
 *
 * We follow the existing `waves.integration.test.ts` convention: fixed UUIDs,
 * minimal valid JSONB payloads, and `withTestDb`-provided seeds for FK parents.
 */

/** Fixed UUIDs — avoids runtime UUID generation. */
const USER_ID = "55555555-5555-5555-5555-555555555555";
const COURSE_ID = "00000000-0000-0000-0000-000000000501";

/** Minimal valid frameworkSnapshot (camelCase — spec §4.8). */
const FRAMEWORK_SNAPSHOT = {
  userMessage: "Here's the framework.",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1],
  tiers: [
    {
      number: 1,
      name: "Basics",
      description: "Intro concepts",
      exampleConcepts: ["foo"],
    },
  ],
};

/** Minimal valid Blueprint for the seed source. */
const BLUEPRINT = {
  topic: "go",
  outline: [],
  openingText: "hi",
  plannedConcepts: [],
};

/** Wave-1 seed source — scoping_handoff carries the blueprint. */
const SEED_SOURCE = { kind: "scoping_handoff", blueprint: BLUEPRINT } as const;

/**
 * Seed the parent user + course rows inside the supplied `withTestDb` scope,
 * then open a Wave so the test has a row to append against. Mirrors the
 * `seedAndRun` pattern in `waves.integration.test.ts`, but inlined here so
 * each test can call `openWave` once.
 */
async function seedAndOpenWave(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
): Promise<Awaited<ReturnType<typeof openWave>>> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "Test User" });
  await db.insert(courses).values({ id: COURSE_ID, userId: USER_ID, topic: "go" });
  return openWave({
    courseId: COURSE_ID,
    waveNumber: 1,
    tier: 1,
    frameworkSnapshot: FRAMEWORK_SNAPSHOT,
    customInstructionsSnapshot: null,
    dueConceptsSnapshot: [],
    seedSource: SEED_SOURCE,
    turnBudget: WAVE.turnCount,
  });
}

describe("appendWaveChatLog", () => {
  // -------------------------------------------------------------------------
  // Test 1: empty default → single entry
  // -------------------------------------------------------------------------
  it("appends a single entry to the empty default chat_log", async () => {
    await withTestDb(async (db) => {
      const wave = await seedAndOpenWave(db);
      // Newly opened waves default to an empty chat_log (column default `[]`).
      expect(wave.chatLog).toEqual([]);

      await appendWaveChatLog(db, wave.id, {
        role: "assistant",
        kind: "text",
        content: "Welcome.",
      });

      const reloaded = await getWaveById(wave.id);
      expect(reloaded.chatLog).toEqual([{ role: "assistant", kind: "text", content: "Welcome." }]);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: ordering across multiple appends
  // -------------------------------------------------------------------------
  it("preserves order across multiple appends", async () => {
    await withTestDb(async (db) => {
      const wave = await seedAndOpenWave(db);

      await appendWaveChatLog(db, wave.id, {
        role: "assistant",
        kind: "text",
        content: "First.",
      });
      await appendWaveChatLog(db, wave.id, {
        role: "user",
        kind: "text",
        content: "Second.",
      });

      const reloaded = await getWaveById(wave.id);
      expect(reloaded.chatLog).toEqual([
        { role: "assistant", kind: "text", content: "First." },
        { role: "user", kind: "text", content: "Second." },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: rollback wipes the append (tx-awareness)
  // -------------------------------------------------------------------------
  it("participates in a caller's transaction (rollback wipes the append)", async () => {
    await withTestDb(async (db) => {
      const wave = await seedAndOpenWave(db);

      // Run inside an explicit tx that throws — Drizzle rolls back automatically.
      // We expect the append performed inside the tx to vanish along with it.
      await expect(
        db.transaction(async (tx) => {
          await appendWaveChatLog(tx, wave.id, {
            role: "assistant",
            kind: "text",
            content: "Tx-only.",
          });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      const reloaded = await getWaveById(wave.id);
      expect(reloaded.chatLog).toEqual([]);
    });
  });
});
