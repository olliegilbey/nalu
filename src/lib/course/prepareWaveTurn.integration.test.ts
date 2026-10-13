import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { setCourseStartingState } from "@/db/queries/courses.scoping";
import { appendWaveChatLog, openWave } from "@/db/queries/waves.writes";
import { getWaveById } from "@/db/queries/waves";
import { appendMessage } from "@/db/queries/contextMessages.writes";
import { getMessagesForWave } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts.writes";
import { insertOpenAssessments } from "@/db/queries/assessments.open";
import { WAVE } from "@/lib/config/tuning";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { prepareWaveTurn } from "./prepareWaveTurn";
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
import { namespaceQuestionId } from "./namespaceQuestionId";

/**
 * Integration tests for `prepareWaveTurn`: the turn-acceptance gate in front
 * of every Wave turn. Real Postgres testcontainer; no LLM. `prepareWaveTurn`
 * runs before any LLM dispatch, so a test that calls it and stops is exactly
 * a turn whose dispatch failed afterwards.
 *
 * Coverage:
 *   1. Accepted chat-text and questionnaire-answers turns.
 *   2. §7.4 mutual-exclusion guards → PRECONDITION_FAILED, nothing written.
 *   3. Close-turn detection at consumed = turnCount - 1.
 *   4. Pre-LLM durability: the learner entry lands on chat_log, but no
 *      context_messages row does (that waits for the LLM's atomic batch).
 *   5. bug_001: a retry after a failed dispatch reuses the orphaned entry.
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

/** Seed user + course + open Wave 1. Returns the ids each test needs. */
async function seedCourseWithOpenWave(): Promise<{
  readonly courseId: string;
  readonly waveId: string;
}> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
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

/**
 * Seed an open questionnaire (1 MC) the way a mid-turn persists one: an
 * assistant_response row, the matching `text_with_questionnaire` chat_log
 * entry (keyed on that row's id), and the placeholder assessment row under
 * its namespaced `question_id` (bug_004).
 */
async function seedOpenMcQuestionnaire(
  courseId: string,
  waveId: string,
): Promise<{ readonly questionnaireMsgId: string }> {
  const concept = await upsertConcept({ courseId, name: "ownership", tier: 1 });
  const assistantPayload: WaveMidTurn = {
    userMessage: "Pick one:",
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
      ],
    },
  };
  const row = await appendMessage({
    parent: { kind: "wave", id: waveId },
    turnIndex: 1,
    seq: 0,
    kind: "assistant_response",
    role: "assistant",
    content: JSON.stringify(assistantPayload),
  });
  // `findOpenQuestionnaire` reads chat_log, not context_messages.
  await appendWaveChatLog(db, waveId, {
    role: "assistant",
    kind: "text_with_questionnaire",
    questionnaireId: row.id,
    content: assistantPayload.userMessage,
    questions: assistantPayload.questionnaire!.questions,
  });
  await insertOpenAssessments({
    waveId,
    turnIndex: 1,
    rows: [
      {
        conceptId: concept.id,
        questionId: namespaceQuestionId(row.id, "q-mc"),
        question: "Pick",
        assessmentKind: "card_mc",
      },
    ],
  });
  return { questionnaireMsgId: row.id };
}

/** Learner entries currently on the wave's chat_log. */
async function learnerEntries(waveId: string): Promise<WaveChatLog> {
  const wave = await getWaveById(waveId);
  return (wave.chatLog as WaveChatLog).filter((e) => e.role === "user");
}

describe("prepareWaveTurn (integration)", () => {
  // -------------------------------------------------------------------------
  // 1. Accepted turns.
  // -------------------------------------------------------------------------
  it("chat-text with no open questionnaire → mid-turn, envelope rendered", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();

      const prep = await prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "tell me about ownership" },
      });

      expect(prep.isCloseTurn).toBe(false);
      // turnsRemaining = WAVE.turnCount - (0 consumed + this turn).
      expect(prep.turnsRemaining).toBe(WAVE.turnCount - 1);
      expect(prep.learnerInput).toContain("tell me about ownership");
    });
  });

  it("questionnaire-answers matching the open questionnaire → accepted, still open for grading", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);

      const prep = await prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: {
          kind: "questionnaire-answers",
          questionnaireId: questionnaireMsgId,
          answers: [{ id: "q-mc", kind: "mc", selected: "B" }],
        },
      });

      expect(prep.isCloseTurn).toBe(false);
      expect(prep.turnsRemaining).toBe(WAVE.turnCount - 1);
      // Dispatch grades against the open questionnaire it derives from
      // dispatchCtx — the learner's just-appended answers must not hide it.
      const openQ = findOpenQuestionnaire(prep.dispatchCtx.wave.chatLog as WaveChatLog);
      expect(openQ?.questionnaireId).toBe(questionnaireMsgId);
    });
  });

  // -------------------------------------------------------------------------
  // 2. §7.4 guards. Each rejects before the pre-LLM append, so chat_log holds
  //    no learner entry afterwards.
  // -------------------------------------------------------------------------
  it("§7.4 chat-text with open questionnaire → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await seedOpenMcQuestionnaire(courseId, waveId);

      const promise = prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "tell me" },
      });
      await expect(promise).rejects.toBeInstanceOf(TRPCError);
      await expect(promise).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(await learnerEntries(waveId)).toHaveLength(0);
    });
  });

  it("§7.4 questionnaire-answers without open questionnaire → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();

      const promise = prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: {
          kind: "questionnaire-answers",
          questionnaireId: "phantom",
          answers: [{ id: "q", kind: "mc", selected: "A" }],
        },
      });
      await expect(promise).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(await learnerEntries(waveId)).toHaveLength(0);
    });
  });

  it("§7.4 stale questionnaireId → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await seedOpenMcQuestionnaire(courseId, waveId);

      const promise = prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: {
          kind: "questionnaire-answers",
          questionnaireId: "stale-id-xyz",
          answers: [{ id: "q-mc", kind: "mc", selected: "B" }],
        },
      });
      await expect(promise).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringMatching(/stale questionnaireId/),
      });
      expect(await learnerEntries(waveId)).toHaveLength(0);
    });
  });

  it("§7.4 answer count mismatch → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);

      // Open questionnaire has 1 question (q-mc); send 2 answers to trip the guard.
      const promise = prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: {
          kind: "questionnaire-answers",
          questionnaireId: questionnaireMsgId,
          answers: [
            { id: "q-mc", kind: "mc", selected: "B" },
            { id: "q-extra", kind: "mc", selected: "A" },
          ],
        },
      });
      await expect(promise).rejects.toBeInstanceOf(TRPCError);
      await expect(promise).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "answer count mismatch",
      });
      expect(await learnerEntries(waveId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Close-turn detection. `consumed` counts user-role chat_log entries, so
  //    seeding turnCount - 1 of them makes this turn the last one.
  // -------------------------------------------------------------------------
  it("consumed = turnCount - 1 → close turn with turnsRemaining 0", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Array-reduce instead of for/let (immutable by default).
      await Array.from({ length: WAVE.turnCount - 1 }).reduce<Promise<void>>(
        async (accP, _v, i) => {
          await accP;
          await appendWaveChatLog(db, waveId, {
            role: "user",
            kind: "text",
            content: `past turn ${i}`,
          });
        },
        Promise.resolve(),
      );

      const prep = await prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "last reply" },
      });

      expect(prep.isCloseTurn).toBe(true);
      expect(prep.turnsRemaining).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Pre-LLM durability. If the LLM transport fails after this point, the
  //    learner's submission survives in `waves.chat_log`. `context_messages`
  //    only gains its user_message row inside the turn runner's atomic batch,
  //    so the two stores diverge on the failure path by design (see
  //    docs/ARCHITECTURE.md, "The two-store split").
  // -------------------------------------------------------------------------
  it("persists learner chat-text to chat_log before dispatch", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();

      await prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "Hello?" },
      });

      expect(await learnerEntries(waveId)).toEqual([
        { role: "user", kind: "text", content: "Hello?" },
      ]);
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.filter((r) => r.kind === "user_message")).toHaveLength(0);
    });
  });

  it("persists learner questionnaire-answers to chat_log before dispatch", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);

      await prepareWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: {
          kind: "questionnaire-answers",
          questionnaireId: questionnaireMsgId,
          answers: [{ id: "q-mc", kind: "mc", selected: "B" }],
        },
      });

      expect(await learnerEntries(waveId)).toEqual([
        {
          role: "user",
          kind: "answers",
          questionnaireId: questionnaireMsgId,
          responses: [{ questionId: "q-mc", choice: "B" }],
        },
      ]);
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.filter((r) => r.kind === "user_message")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. bug_001: the pre-LLM append is idempotent on retry. The first call
  //    stands for an attempt whose dispatch then failed, orphaning the learner
  //    entry. The identical retry must reuse it: one entry, same budget.
  // -------------------------------------------------------------------------
  it("retry after a failed dispatch does not double-append chat-text", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const params = {
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text" as const, text: "explain ownership" },
      };

      const first = await prepareWaveTurn(params);
      const retry = await prepareWaveTurn(params);

      expect(await learnerEntries(waveId)).toHaveLength(1);
      expect(retry.turnsRemaining).toBe(first.turnsRemaining);
      expect(retry.turnsRemaining).toBe(WAVE.turnCount - 1);
    });
  });

  it("retry after a failed dispatch does not double-append answers or close the questionnaire", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);
      const params = {
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: {
          kind: "questionnaire-answers" as const,
          questionnaireId: questionnaireMsgId,
          answers: [{ id: "q-mc", kind: "mc" as const, selected: "B" as const }],
        },
      };

      await prepareWaveTurn(params);
      // The retry MUST NOT throw "no open questionnaire": the orphaned answers
      // entry must not count as having answered the questionnaire.
      const retry = await prepareWaveTurn(params);

      expect(await learnerEntries(waveId)).toHaveLength(1);
      // Dispatch must still see the questionnaire as open, or grading is
      // silently skipped.
      const openQ = findOpenQuestionnaire(retry.dispatchCtx.wave.chatLog as WaveChatLog);
      expect(openQ?.questionnaireId).toBe(questionnaireMsgId);
    });
  });
});
