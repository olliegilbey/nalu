import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { closeWave, openWave } from "@/db/queries/waves";
import { appendMessage } from "@/db/queries/contextMessages";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { WAVE } from "@/lib/config/tuning";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import { KEY_TO_INDEX } from "./buildLearnerInput";
import { getWaveState } from "./getWaveState";

/**
 * Integration tests for `getWaveState`. Uses real Postgres (testcontainer) so
 * the (turn_index, seq) ordering + open-questionnaire reconstruction in
 * `loadWaveContext` exercise the real query path. Filename uses the
 * `.integration.test.ts` suffix so the unit project's exclude glob skips it
 * (per `vitest.unit.config.ts`); the integration project's include glob picks
 * it up via `src/**\/*.integration.test.ts`.
 *
 * Coverage:
 *   1. Active wave with one user turn → turnsRemaining = WAVE.turnCount - 1.
 *   2. Wave with open questionnaire → openQuestionnaire is the redacted shape
 *      (correctEnc present, correct absent).
 *   3. Closed wave → status: "closed".
 *   4. Missing waveNumber → NOT_FOUND.
 */

const USER_ID = "77777777-7777-7777-7777-777777777777";

const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["b"] },
  ],
} as const;

/** Seed user + course + open Wave 1; returns the ids needed by tests. */
async function seedCourseWithOpenWave(): Promise<{
  readonly courseId: string;
  readonly waveId: string;
}> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
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

describe("getWaveState (integration)", () => {
  // -------------------------------------------------------------------------
  // 1. Active wave + one consumed user turn → turnsRemaining = turnCount - 1.
  //    Verifies the rendered-messages projection trims to (id, turnIndex, seq,
  //    kind, role, content) and preserves (turn_index, seq) ordering.
  // -------------------------------------------------------------------------
  it("active wave with one user_message → turnsRemaining = turnCount - 1", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Two rows on the same turn: a user_message (consumes a turn) + an
      // assistant_response (does not). Result: consumed=1.
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

      const state = await getWaveState({ userId: USER_ID, courseId, waveNumber: 1 });

      expect(state.status).toBe("open");
      expect(state.waveId).toBe(waveId);
      expect(state.waveNumber).toBe(1);
      expect(state.tier).toBe(1);
      expect(state.turnsRemaining).toBe(WAVE.turnCount - 1);
      expect(state.renderedMessages).toHaveLength(2);
      // Ordering: turn 0 seq 0 first, then seq 1.
      expect(state.renderedMessages[0]).toMatchObject({
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
      });
      expect(state.renderedMessages[1]).toMatchObject({
        turnIndex: 0,
        seq: 1,
        kind: "assistant_response",
        role: "assistant",
      });
      expect(state.openQuestionnaire).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Wave with an open questionnaire (assistant_response carries
  //    questionnaire JSON, no subsequent user reply). openQuestionnaire must
  //    be the redacted client shape: correctEnc present, no plaintext correct.
  // -------------------------------------------------------------------------
  it("open questionnaire → projected redacted shape (correctEnc, no correct)", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const payload: WaveMidTurn = {
        userMessage: "Try these:",
        questionnaire: {
          questions: [
            {
              id: "q-mc",
              type: "multiple_choice",
              prompt: "Pick",
              options: { A: "a", B: "b", C: "c", D: "d" },
              correct: "B",
              freetextRubric: "rmc",
              conceptName: "ownership",
              tier: 1,
            },
            {
              id: "q-ft",
              type: "free_text",
              prompt: "Why?",
              freetextRubric: "rft",
              conceptName: "borrowing",
              tier: 1,
            },
          ],
        },
      };
      // Persist the assistant_response at turn 1 — no user reply follows, so
      // loadWaveContext reconstructs this as the open questionnaire.
      await appendMessage({
        parent: { kind: "wave", id: waveId },
        turnIndex: 1,
        seq: 0,
        kind: "assistant_response",
        role: "assistant",
        content: JSON.stringify(payload),
      });

      const state = await getWaveState({ userId: USER_ID, courseId, waveNumber: 1 });

      expect(state.openQuestionnaire).not.toBeNull();
      const open = state.openQuestionnaire!;
      expect(open.questions).toHaveLength(2);
      // MC question: correctEnc present, plaintext correct absent.
      const mc = open.questions[0]!;
      expect(mc.type).toBe("multiple_choice");
      expect(mc).not.toHaveProperty("correct");
      if (mc.type !== "multiple_choice") throw new Error("type narrow");
      // round-trip: encoded blob decodes back to KEY_TO_INDEX[B] = 1 when
      // paired with the question id.
      expect(decodeCorrect("q-mc", mc.correctEnc)).toBe(KEY_TO_INDEX.B);
      // Free-text branch: no options/correctEnc, rubric preserved.
      const ft = open.questions[1]!;
      expect(ft.type).toBe("free_text");
      expect(ft).not.toHaveProperty("options");
      expect(ft).not.toHaveProperty("correctEnc");
      expect(ft.freetextRubric).toBe("rft");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Closed wave → status: "closed". closeWave requires a summary; we use
  //    a minimal blueprint payload (or null) to satisfy the column types.
  // -------------------------------------------------------------------------
  it("closed wave → status='closed'", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Close with a null blueprint — schema permits this for course-end Waves.
      await closeWave(waveId, { summary: "closed for test", blueprintEmitted: null });

      const state = await getWaveState({ userId: USER_ID, courseId, waveNumber: 1 });

      expect(state.status).toBe("closed");
      expect(state.openQuestionnaire).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Missing waveNumber → TRPCError NOT_FOUND. Distinguishes "no such wave"
  //    from ownership violations (handled inside loadWaveContext).
  // -------------------------------------------------------------------------
  it("waveNumber that doesn't exist → TRPC NOT_FOUND", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      await expect(
        getWaveState({ userId: USER_ID, courseId, waveNumber: 99 }),
      ).rejects.toBeInstanceOf(TRPCError);
    });
  });
});
