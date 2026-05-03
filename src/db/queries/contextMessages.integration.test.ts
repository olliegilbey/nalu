import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { userProfiles, courses, scopingPasses, waves } from "@/db/schema";
import {
  appendMessage,
  getMessagesForWave,
  getMessagesForScopingPass,
  getNextTurnIndex,
  getLastAssessmentCard,
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
    turnBudget: 10,
  });
}

describe("contextMessages queries", () => {
  // -------------------------------------------------------------------------
  // Test 1: appendMessage + getMessagesForWave — (turn_index, seq) ordering
  // -------------------------------------------------------------------------
  it("appendMessage + getMessagesForWave preserves (turn_index, seq) order", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Append two messages on the same turn with different seq values.
      await appendMessage({
        parent: { kind: "wave", id: WAVE },
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "<user_message>hi</user_message>",
      });
      await appendMessage({
        parent: { kind: "wave", id: WAVE },
        turnIndex: 0,
        seq: 1,
        kind: "harness_turn_counter",
        role: "user",
        content: "<turns_remaining>9 left</turns_remaining>",
      });

      const rows = await getMessagesForWave(WAVE);
      expect(rows).toHaveLength(2);
      // Order must be (turnIndex ASC, seq ASC) — user_message before counter.
      expect(rows[0]?.kind).toBe("user_message");
      expect(rows[1]?.seq).toBe(1);
    });
  });

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
  // Test 4: CHECK constraint rejects a row with neither parent set
  // -------------------------------------------------------------------------
  it("CHECK constraint rejects a row with both wave_id and scoping_pass_id NULL", async () => {
    // No seed needed — the bad insert does not reference any parent FK.
    await withTestDb(async (db) => {
      // Raw SQL bypasses the typed builder; the XOR CHECK fires at the DB level.
      // Both parent columns are NULL → violates `context_messages_one_parent`.
      await expect(
        db.execute(
          sql`INSERT INTO context_messages (turn_index, seq, kind, role, content)
              VALUES (0, 0, 'user_message', 'user', 'x')`,
        ),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: getLastAssessmentCard — extracts and validates <assessment> JSON
  // -------------------------------------------------------------------------
  it("getLastAssessmentCard extracts JSON from <assessment> tag", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Minimal valid AssessmentCard payload (multiple_choice variant).
      // PRD mandates exactly 4 options; updated fixture to match tightened schema.
      const assessmentPayload = {
        questions: [
          {
            question_id: "q1",
            concept_name: "c",
            tier: 1,
            type: "multiple_choice",
            question: "?",
            options: { A: "a", B: "b", C: "c", D: "d" },
            correct: "A",
          },
        ],
      };

      await appendMessage({
        parent: { kind: "wave", id: WAVE },
        turnIndex: 0,
        seq: 0,
        kind: "assistant_response",
        role: "assistant",
        content:
          "<response>hi</response>\n<assessment>" +
          JSON.stringify(assessmentPayload) +
          "</assessment>",
      });

      const card = await getLastAssessmentCard(WAVE);
      expect(card).not.toBeNull();
      expect(card?.questions[0]?.question_id).toBe("q1");
      expect(card?.questions[0]?.type).toBe("multiple_choice");
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: getLastAssessmentCard — null when wave has no assistant_response rows
  // -------------------------------------------------------------------------
  it("getLastAssessmentCard returns null when wave has only user_message rows", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // Only a user message — no assistant_response rows exist for this wave.
      await appendMessage({
        parent: { kind: "wave", id: WAVE },
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "<user_message>hello</user_message>",
      });

      const card = await getLastAssessmentCard(WAVE);
      expect(card).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 7: getLastAssessmentCard — null when assistant_response has no <assessment> tag
  // -------------------------------------------------------------------------
  it("getLastAssessmentCard returns null when assistant_response contains no <assessment> tag", async () => {
    await withTestDb(async (db) => {
      await seedFixtures(db);

      // An assistant response with no <assessment> block — teaching turn only.
      await appendMessage({
        parent: { kind: "wave", id: WAVE },
        turnIndex: 0,
        seq: 0,
        kind: "assistant_response",
        role: "assistant",
        content: "<response>hi</response>",
      });

      const card = await getLastAssessmentCard(WAVE);
      expect(card).toBeNull();
    });
  });
});
