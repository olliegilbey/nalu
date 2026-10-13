import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { setCourseStartingState } from "@/db/queries/courses.scoping";
import { openWave, appendWaveChatLog } from "@/db/queries/waves.writes";
import { appendMessage } from "@/db/queries/contextMessages";
import { WAVE } from "@/lib/config/tuning";
import { appRouter } from "./index";

/**
 * Integration tests for `wave.ts` — the tRPC transport for Wave state.
 *
 * Router-level coverage focuses on three things (per plan §13):
 *   1. Wire shape arrives intact through Zod input validation.
 *   2. Lib-layer return values surface to the caller.
 *   3. Lib-layer `TRPCError` codes (NOT_FOUND) propagate.
 *
 * Heavy branch coverage of the lib function lives in
 * `getWaveState.integration.test.ts`. Learner turns do not go through tRPC;
 * their coverage lives in `prepareWaveTurn`, `persistWaveMidTurn`,
 * `executeWaveClose`, and `streamWaveTurn` integration tests.
 */

const USER_ID = "55555555-5555-5555-5555-555555555555";

const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["b"] },
  ],
} as const;

/** Seed user + active course + open Wave 1. Mirrors the lib-level integration tests. */
async function seedCourseWithOpenWave(): Promise<{
  readonly courseId: string;
  readonly waveId: string;
}> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  // Activate the course, as scoping close does before Wave 1 opens.
  await setCourseStartingState(course.id, {
    initialSummary: "seed",
    startingTier: 1,
    currentTier: 1,
  });
  const wave = await openWave({
    courseId: course.id,
    waveNumber: 1,
    tier: 1,
    frameworkSnapshot: FRAMEWORK,
    customInstructionsSnapshot: null,
    dueConceptsSnapshot: [],
    seedSource: {
      kind: "scoping_handoff",
      blueprint: {
        topic: "Ownership basics",
        outline: ["x"],
        openingText: "hi",
        plannedConcepts: [],
      },
    },
    turnBudget: WAVE.turnCount,
  });
  return { courseId: course.id, waveId: wave.id };
}

// ===========================================================================
// wave.getState
// ===========================================================================

describe("wave.getState", () => {
  // -------------------------------------------------------------------------
  // 1. Active wave with one consumed user-turn → router returns the projected
  //    WaveState shape: status='active', currentTier echoed, turnsRemaining
  //    reflects the chat_log (single source of truth post-T11), chatLog
  //    contains the redacted entries, closeResult always null on getState.
  // -------------------------------------------------------------------------
  it("returns projected WaveState for an active wave", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // One past turn — dual-written to both stores to mirror production:
      // context_messages is the byte-stable LLM replay; chat_log is the
      // typed UI projection. getWaveState reads chat_log only.
      await appendMessage({
        parent: { kind: "wave", id: waveId },
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "<learner_reply>hi</learner_reply>",
      });
      await appendMessage({
        parent: { kind: "wave", id: waveId },
        turnIndex: 0,
        seq: 1,
        kind: "assistant_response",
        role: "assistant",
        content: JSON.stringify({ userMessage: "hello back" }),
      });
      await appendWaveChatLog(db, waveId, {
        role: "user",
        kind: "text",
        content: "hi",
      });
      await appendWaveChatLog(db, waveId, {
        role: "assistant",
        kind: "text",
        content: "hello back",
      });

      const caller = appRouter.createCaller({ userId: USER_ID });
      const state = await caller.wave.getState({ courseId, waveNumber: 1 });

      expect(state.status).toBe("active");
      expect(state.waveId).toBe(waveId);
      expect(state.currentTier).toBe(1);
      expect(state.turnsRemaining).toBe(WAVE.turnCount - 1);
      // chatLog wire: two redacted entries (user text + assistant text).
      // No `text_with_questionnaire` present, so no open questionnaire is
      // derivable from the log.
      expect(state.chatLog).toHaveLength(2);
      expect(state.chatLog[0]).toMatchObject({ role: "user", kind: "text" });
      expect(state.chatLog[1]).toMatchObject({ role: "assistant", kind: "text" });
      expect(
        state.chatLog.some((e) => e.role === "assistant" && e.kind === "text_with_questionnaire"),
      ).toBe(false);
      // closeResult is structurally null on getState — the close payload comes
      // from the turn stream's data-turn-result part (the field is a
      // documentation handle for client union stability).
      expect(state.closeResult).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Missing wave → NOT_FOUND propagates as a TRPCError from the lib layer.
  // -------------------------------------------------------------------------
  it("throws NOT_FOUND when the wave doesn't exist", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      const caller = appRouter.createCaller({ userId: USER_ID });
      await expect(caller.wave.getState({ courseId, waveNumber: 99 })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });
});
