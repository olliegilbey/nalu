import { describe, it, expect } from "vitest";
import { WAVE as WAVE_CONFIG } from "@/lib/config/tuning";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses, scopingPasses, waves } from "@/db/schema";
import { appendMessage, appendMessages } from "./contextMessages.writes";
import {
  getMessagesForWave,
  getMessagesForScopingPass,
  getNextTurnIndex,
  getLatestAssistantResponseForWave,
} from "./contextMessages";

/** Fixed UUIDs per plan §D7. */
const USER = "55555555-5555-5555-5555-555555555555";
const COURSE = "00000000-0000-0000-0000-000000000501";
const WAVE = "00000000-0000-0000-0000-000000000502";
const SCOPING = "00000000-0000-0000-0000-000000000503";

/**
 * Minimal valid `frameworkSnapshot` for the waves FK seed row.
 * Must satisfy `frameworkJsonbSchema` (topic, scope_summary, etc.).
 */
const FRAMEWORK_SNAPSHOT = {
  topic: "x",
  scope_summary: "y",
  estimated_starting_tier: 1,
  baseline_scope_tiers: [1],
  tiers: [{ number: 1, name: "n", description: "d", example_concepts: ["e"] }],
} as const;

/**
 * Seed the standard test fixtures into the current `withTestDb` transaction.
 * Must be called inside a `withTestDb` callback because `withTestDb` truncates
 * before each invocation — seeding outside would be wiped.
 */
async function seedFixtures(db: Parameters<Parameters<typeof withTestDb>[0]>[0]): Promise<void> {
  await db.insert(userProfiles).values({ id: USER, displayName: "U" });
  await db.insert(courses).values({ id: COURSE, userId: USER, topic: "x" });
  await db.insert(scopingPasses).values({ id: SCOPING, courseId: COURSE });
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
}

describe("contextMessages queries", () => {
  // -------------------------------------------------------------------------
  // Test 2: getMessagesForScopingPass scopes to scoping_pass_id only
  // -------------------------------------------------------------------------
  it("getMessagesForScopingPass scopes to scoping_pass_id, does not bleed into wave", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Insert one scoping-pass message — must NOT appear in wave queries.
      await appendMessage({
        parent: { kind: "scoping", id: SCOPING },
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "scope",
      });

      // Scoping pass query returns the row.
      const scopingRows = await getMessagesForScopingPass(SCOPING);
      expect(scopingRows).toHaveLength(1);
      // Wave query for the same course returns nothing.
      const waveRows = await getMessagesForWave(WAVE);
      expect(waveRows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: getNextTurnIndex — 0 when empty, 1 after first append
  // -------------------------------------------------------------------------
  it("getNextTurnIndex returns 0 when empty, then increments to 1 after first append", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // No messages yet → next turn index is 0.
      const before = await getNextTurnIndex({ kind: "wave", id: WAVE });
      expect(before).toBe(0);

      // Append turn 0, seq 0.
      await appendMessage({
        parent: { kind: "wave", id: WAVE },
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "x",
      });

      // max(turn_index) is now 0, so next is 1.
      const after = await getNextTurnIndex({ kind: "wave", id: WAVE });
      expect(after).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getLatestAssistantResponseForWave — newest assistant_response by turn
  // -------------------------------------------------------------------------
  it("getLatestAssistantResponseForWave returns the newest assistant_response, or null", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);
      const parent = { kind: "wave", id: WAVE } as const;

      expect(await getLatestAssistantResponseForWave(WAVE, db)).toBeNull();

      // Turn 2 holds only a user_message, so the kind filter must skip it.
      const rows = await appendMessages([
        {
          parent,
          turnIndex: 0,
          seq: 0,
          kind: "assistant_response",
          role: "assistant",
          content: "a",
        },
        { parent, turnIndex: 1, seq: 0, kind: "user_message", role: "user", content: "q" },
        {
          parent,
          turnIndex: 1,
          seq: 1,
          kind: "assistant_response",
          role: "assistant",
          content: "b",
        },
        { parent, turnIndex: 2, seq: 0, kind: "user_message", role: "user", content: "r" },
      ]);

      expect(await getLatestAssistantResponseForWave(WAVE, db)).toEqual({
        id: rows[2]?.id,
        turnIndex: 1,
      });
    });
  });
});
