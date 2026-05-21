import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { appendWaveChatLog, closeWave, openWave } from "@/db/queries/waves";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { WAVE } from "@/lib/config/tuning";
import { KEY_TO_INDEX } from "./buildLearnerInput";
import { getWaveState } from "./getWaveState";

/**
 * Integration tests for `getWaveState`. Uses real Postgres (testcontainer)
 * because the new read path projects the typed JSONB `waves.chat_log` column
 * directly — the unit tests can't exercise Postgres JSONB semantics + the
 * row-guard validation in `getWaveByCourseAndNumber`.
 *
 * Coverage (post-rewrite — chat_log is now authoritative; no `loadWaveContext`
 * reconstruction; no `context_messages` reads):
 *   1. Redacted chat_log — `text_with_questionnaire` entry redacts MC `correct`
 *      to a `correctEnc` blob that round-trips through `decodeCorrect`.
 *   2. `turnsRemaining` is derived from user-role chat_log entries — assistant
 *      entries don't decrement.
 *   3. Closed wave → `status: "closed"`.
 *   4. Missing waveNumber → TRPC NOT_FOUND.
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
  // 1. Redacted chat_log — assistant `text_with_questionnaire` entry must
  //    appear in `state.chatLog` with MC `correct` replaced by `correctEnc`.
  //    Verifies the wire shape matches `WaveChatLogEntryForClient` (no
  //    plaintext `correct`, round-trips through `decodeCorrect`).
  // -------------------------------------------------------------------------
  it("text_with_questionnaire entry is redacted (correctEnc, no correct)", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Append one assistant entry that opens a questionnaire. MC `correct`
      // is "C" on the chat_log side; the wire must surface only `correctEnc`.
      await appendWaveChatLog(db, waveId, {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "qz-1",
        content: "Try this:",
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "Pick",
            options: { A: "a", B: "b", C: "c", D: "d" },
            correct: "C",
            freetextRubric: "n/a",
          },
        ],
      });

      const state = await getWaveState({ userId: USER_ID, courseId, waveNumber: 1 });

      expect(state.chatLog).toHaveLength(1);
      const entry = state.chatLog[0]!;
      // Narrow to the questionnaire arm so we can inspect the MC redaction.
      if (entry.role !== "assistant" || entry.kind !== "text_with_questionnaire") {
        throw new Error("expected text_with_questionnaire entry");
      }
      const mc = entry.questions[0]!;
      if (mc.type !== "multiple_choice") throw new Error("expected MC question");
      // Plaintext `correct` MUST NOT appear on the wire shape.
      expect("correct" in mc).toBe(false);
      // Round-trip: questionId-bound `correctEnc` decodes back to KEY_TO_INDEX.C.
      expect(decodeCorrect("q1", mc.correctEnc)).toBe(KEY_TO_INDEX.C);
    });
  });

  // -------------------------------------------------------------------------
  // 2. `turnsRemaining` derives from user-role chat_log entries.
  //    Sequence: assistant text → user text → assistant text. Only the user
  //    entry counts as a consumed turn, so turnsRemaining = turnCount - 1.
  //    Confirms the count ignores assistant rows (the LLM "turn" is a no-op
  //    on the budget — only learner submissions advance it).
  // -------------------------------------------------------------------------
  it("turnsRemaining counts user-role entries only", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await appendWaveChatLog(db, waveId, {
        role: "assistant",
        kind: "text",
        content: "hi",
      });
      await appendWaveChatLog(db, waveId, {
        role: "user",
        kind: "text",
        content: "hello",
      });
      await appendWaveChatLog(db, waveId, {
        role: "assistant",
        kind: "text",
        content: "ack",
      });

      const state = await getWaveState({ userId: USER_ID, courseId, waveNumber: 1 });

      expect(state.status).toBe("active");
      expect(state.turnsRemaining).toBe(WAVE.turnCount - 1);
      expect(state.chatLog).toHaveLength(3);
      // closeResult is always null on getWaveState — the close result is the
      // *response* payload of submitWaveTurn, not re-readable here.
      expect(state.closeResult).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Closed wave → status: "closed". closeWave requires a summary; we use
  //    a null blueprint payload (permitted for course-end Waves).
  // -------------------------------------------------------------------------
  it("closed wave → status='closed'", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await closeWave(waveId, { summary: "closed for test", blueprintEmitted: null });

      const state = await getWaveState({ userId: USER_ID, courseId, waveNumber: 1 });

      expect(state.status).toBe("closed");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Missing waveNumber → TRPCError NOT_FOUND. Distinguishes "no such wave"
  //    from ownership violations (handled inside the wave resolver path).
  // -------------------------------------------------------------------------
  it("waveNumber that doesn't exist → TRPC NOT_FOUND", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      // Assert both the error type AND the specific code: a bare
      // `instanceof TRPCError` would pass on the WRONG code (e.g. a
      // FORBIDDEN ownership error), masking a regression in the
      // "no such wave" path.
      const promise = getWaveState({ userId: USER_ID, courseId, waveNumber: 99 });
      await expect(promise).rejects.toBeInstanceOf(TRPCError);
      await expect(promise).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
