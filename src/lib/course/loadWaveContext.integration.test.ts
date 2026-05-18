import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { openWave } from "@/db/queries/waves";
import { appendMessage } from "@/db/queries/contextMessages";
import { WAVE } from "@/lib/config/tuning";
import { loadWaveContext } from "./loadWaveContext";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";

/**
 * Integration tests for `loadWaveContext`.
 *
 * Runs against the real Postgres testcontainer so JSONB validation, FK checks,
 * and message ordering all exercise the same paths as production. Each
 * `withTestDb` call truncates every table first.
 *
 * Coverage:
 *   1. No assistant_response messages → openQuestionnaire is null.
 *   2. assistant_response with no questionnaire block → null.
 *   3. assistant_response with a questionnaire (no follow-up) → projected record.
 *   4. assistant_response with a questionnaire followed by a card_answer → null
 *      (consumed).
 *   5. Cross-course wave id → FORBIDDEN.
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

/**
 * Open a single Wave under a fresh course owned by USER_ID. Returns the ids
 * each test needs (course + wave). User is upserted only once per `withTestDb`.
 */
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

/** Minimal valid WaveMidTurn JSON content with no questionnaire. */
const MID_NO_QN: WaveMidTurn = {
  userMessage: "Teaching turn with no questions.",
};

/** Minimal valid WaveMidTurn JSON content carrying one MC + one free-text. */
const MID_WITH_QN: WaveMidTurn = {
  userMessage: "Here are some questions.",
  questionnaire: {
    questions: [
      {
        id: "q-mc",
        type: "multiple_choice",
        prompt: "Pick one",
        options: { A: "a", B: "b", C: "c", D: "d" },
        correct: "B",
        freetextRubric: "rubric-mc",
      },
      {
        id: "q-ft",
        type: "free_text",
        prompt: "Explain",
        freetextRubric: "rubric-ft",
      },
    ],
  },
};

describe("loadWaveContext (integration)", () => {
  it("returns openQuestionnaire=null when the wave has no assistant_response", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const result = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      expect(result.openQuestionnaire).toBeNull();
      expect(result.wave.id).toBe(waveId);
      expect(result.course.id).toBe(courseId);
    });
  });

  it("returns openQuestionnaire=null when the last assistant_response has no questionnaire", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Seed one assistant_response that omits the questionnaire block.
      await appendMessage({
        parent: { kind: "wave", id: waveId },
        turnIndex: 1,
        seq: 0,
        kind: "assistant_response",
        role: "assistant",
        content: JSON.stringify(MID_NO_QN),
      });
      const result = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      expect(result.openQuestionnaire).toBeNull();
    });
  });

  it("projects the questionnaire when the latest assistant_response carries one and has no follow-up", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // The message row id IS the questionnaire's identity (see loadWaveContext.ts).
      const row = await appendMessage({
        parent: { kind: "wave", id: waveId },
        turnIndex: 1,
        seq: 0,
        kind: "assistant_response",
        role: "assistant",
        content: JSON.stringify(MID_WITH_QN),
      });
      const result = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      expect(result.openQuestionnaire).not.toBeNull();
      expect(result.openQuestionnaire?.questionnaireId).toBe(row.id);
      expect(result.openQuestionnaire?.questions).toHaveLength(2);
      // MC question should preserve options + correct key.
      expect(result.openQuestionnaire?.questions[0]).toMatchObject({
        id: "q-mc",
        type: "multiple_choice",
        options: { A: "a", B: "b", C: "c", D: "d" },
        correct: "B",
        freetextRubric: "rubric-mc",
      });
      // Free-text question should NOT carry options/correct.
      expect(result.openQuestionnaire?.questions[1]).toMatchObject({
        id: "q-ft",
        type: "free_text",
        freetextRubric: "rubric-ft",
      });
      expect(result.openQuestionnaire?.questions[1]).not.toHaveProperty("options");
      expect(result.openQuestionnaire?.questions[1]).not.toHaveProperty("correct");
    });
  });

  it("returns openQuestionnaire=null once a card_answer follows the latest assistant_response", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await appendMessage({
        parent: { kind: "wave", id: waveId },
        turnIndex: 1,
        seq: 0,
        kind: "assistant_response",
        role: "assistant",
        content: JSON.stringify(MID_WITH_QN),
      });
      // Follow-up learner turn — the questionnaire is now consumed.
      await appendMessage({
        parent: { kind: "wave", id: waveId },
        turnIndex: 2,
        seq: 0,
        kind: "card_answer",
        role: "user",
        content: "<questionnaire_answers>...</questionnaire_answers>",
      });
      const result = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      expect(result.openQuestionnaire).toBeNull();
    });
  });

  it("throws FORBIDDEN when the wave id does not belong to the supplied courseId", async () => {
    await withTestDb(async () => {
      await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
      // Course A owns the wave; course B is passed in as the supposed parent.
      const courseA = await createCourse({ userId: USER_ID, topic: "Rust A" });
      const courseB = await createCourse({ userId: USER_ID, topic: "Rust B" });
      const waveA = await openWave({
        courseId: courseA.id,
        waveNumber: 1,
        tier: 1,
        frameworkSnapshot: FRAMEWORK,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: [],
        seedSource: {
          kind: "scoping_handoff",
          blueprint: { topic: "x", outline: ["x"], openingText: "x", plannedConcepts: [] },
        },
        turnBudget: WAVE.turnCount,
      });
      await expect(
        loadWaveContext({ userId: USER_ID, courseId: courseB.id, waveId: waveA.id }),
      ).rejects.toMatchObject({
        // TRPCError carries the code on the instance itself.
        code: "FORBIDDEN",
      } satisfies Partial<TRPCError>);
    });
  });
});
