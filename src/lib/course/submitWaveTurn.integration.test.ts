import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles, contextMessages } from "@/db/schema";
import { createCourse, setCourseStartingState } from "@/db/queries/courses";
import { getWaveById, openWave } from "@/db/queries/waves";
import { appendMessage, getMessagesForWave, getNextTurnIndex } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts";
import { insertOpenAssessments } from "@/db/queries/assessments";
import { WAVE } from "@/lib/config/tuning";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { submitWaveTurn } from "./submitWaveTurn";
import type { ExecuteTurnParams, ExecuteTurnResult } from "@/lib/turn/executeTurn";

/**
 * Integration tests for `submitWaveTurn`. Real Postgres testcontainer for
 * everything; `executeTurn` is mocked per-test via `vi.spyOn`. The mock
 * persists user_message + assistant_response rows so the orchestrators
 * downstream observe production-shaped context_messages.
 *
 * Coverage (plan §13 step 4):
 *   1. Chat-text path → executeWaveMid (kind: "mid-turn").
 *   2. Questionnaire-answers path → executeWaveMid; assessment row updated.
 *   3. §7.4 chat-text with open questionnaire → PRECONDITION_FAILED.
 *   4. §7.4 questionnaire-answers without open questionnaire → PRECONDITION_FAILED.
 *   5. §7.4 stale questionnaireId → PRECONDITION_FAILED.
 *   6. Close-turn dispatch: when consumed = turnCount - 1 → executeWaveClose
 *      (kind: "close-turn").
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
async function seedCourseWithOpenWave(
  waveNumber = 1,
): Promise<{ readonly courseId: string; readonly waveId: string }> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  // Activate course so close-turn tests can write totalXp without a CHECK trip.
  await setCourseStartingState(course.id, {
    initialSummary: "seed",
    startingTier: 1,
    currentTier: 1,
  });
  const wave = await openWave({
    courseId: course.id,
    waveNumber,
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
 * Mock for `executeTurn`. Persists user + assistant rows at the next turn_index
 * so downstream code observes production shape. Mirrors the pattern used by
 * `executeWaveMid.integration.test.ts` / `executeWaveClose.integration.test.ts`.
 */
function makeMidTurnMock(parsed: WaveMidTurn) {
  return async <T>(params: ExecuteTurnParams<T>): Promise<ExecuteTurnResult<T>> => {
    if (params.parent.kind !== "wave") throw new Error("test mock: wave only");
    const turnIndex = await getNextTurnIndex(params.parent);
    await appendMessage({
      parent: params.parent,
      turnIndex,
      seq: 0,
      kind: "user_message",
      role: "user",
      content: params.userMessageContent,
    });
    await appendMessage({
      parent: params.parent,
      turnIndex,
      seq: 1,
      kind: "assistant_response",
      role: "assistant",
      content: JSON.stringify(parsed),
    });
    return {
      parsed: parsed as unknown as T,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      },
    };
  };
}

/** Close-turn parsed shape, matching what the wave-close LLM emits. */
function makeCloseParsed(): WaveCloseTurn {
  return {
    userMessage: "Closing chat.",
    summary: "We covered ownership.",
    gradings: [],
    nextUnitBlueprint: {
      topic: "Borrowing rules",
      outline: ["borrow"],
      openingText: "Welcome to lesson 2.",
      plannedConcepts: [{ name: "ownership", tier: 1, role: "fresh" }],
    },
    conceptUpdates: [],
  };
}

/**
 * Seed an open questionnaire (1 MC) on the wave + the matching placeholder
 * assessment row. The MC carries `correct: "B"` so the chat-text rejection
 * test has a real open questionnaire to bump against.
 */
async function seedOpenMcQuestionnaire(
  courseId: string,
  waveId: string,
): Promise<{ readonly questionnaireMsgId: string }> {
  await upsertConcept({ courseId, name: "ownership", tier: 1 });
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
  // Match what executeWaveMid would have written when the questionnaire dropped.
  const concept = await upsertConcept({ courseId, name: "ownership", tier: 1 });
  await insertOpenAssessments({
    waveId,
    turnIndex: 1,
    rows: [
      {
        conceptId: concept.id,
        questionId: "q-mc",
        question: "Pick",
        assessmentKind: "card_mc",
      },
    ],
  });
  return { questionnaireMsgId: row.id };
}

describe("submitWaveTurn (integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Chat-text path with no open questionnaire → executeWaveMid is dispatched.
  //    Verifies the result discriminator and the assistant message persists.
  // -------------------------------------------------------------------------
  it("chat-text with no open questionnaire → dispatches executeWaveMid", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      const parsed: WaveMidTurn = { userMessage: "Got it." };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeMidTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const result = await submitWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "tell me about ownership" },
      });

      expect(result.kind).toBe("mid-turn");
      if (result.kind !== "mid-turn") throw new Error("expected mid-turn");
      expect(result.assistantContent).toBe("Got it.");
      expect(result.newQuestionnaire).toBeNull();
      // turnsRemaining = WAVE.turnCount - (0 + 1) = 9 (this turn's value).
      expect(result.turnsRemaining).toBe(WAVE.turnCount - 1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Questionnaire-answers path against a real open questionnaire →
  //    executeWaveMid runs grading and updates the assessment row.
  // -------------------------------------------------------------------------
  it("questionnaire-answers (matching open questionnaire) → mid-turn dispatch + assessment update", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);
      // Model emits a comprehensionSignal for the MC question so grading runs.
      const parsed: WaveMidTurn = {
        userMessage: "Right!",
        comprehensionSignals: [{ kind: "mc-index", questionId: "q-mc", rationale: "got it" }],
      };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeMidTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const result = await submitWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: {
          kind: "questionnaire-answers",
          questionnaireId: questionnaireMsgId,
          answers: [{ id: "q-mc", kind: "mc", selected: "B" }],
        },
      });

      expect(result.kind).toBe("mid-turn");
      if (result.kind !== "mid-turn") throw new Error("expected mid-turn");
      expect(result.gradedSignals).toHaveLength(1);
      expect(result.gradedSignals[0]).toMatchObject({
        questionId: "q-mc",
        correct: true,
      });
      // Mid-turn turnsRemaining = WAVE.turnCount - 1.
      expect(result.turnsRemaining).toBe(WAVE.turnCount - 1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. §7.4: chat-text submitted while an open questionnaire exists → reject
  //    before any LLM call. The error code carries the precondition reason so
  //    the router can surface a descriptive message to the client.
  // -------------------------------------------------------------------------
  it("§7.4 chat-text with open questionnaire → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await seedOpenMcQuestionnaire(courseId, waveId);
      // Mock executeTurn so a regression (calling it past the guard) fails
      // loudly — the test expects the guard to short-circuit before dispatch.
      const spy = vi
        .spyOn(executeTurnModule, "executeTurn")
        .mockImplementation(
          makeMidTurnMock({ userMessage: "x" }) as unknown as typeof executeTurnModule.executeTurn,
        );

      const promise = submitWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "tell me" },
      });
      await expect(promise).rejects.toBeInstanceOf(TRPCError);
      await expect(promise).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. §7.4: questionnaire-answers submitted without an open questionnaire →
  //    reject. The composer should not permit this; the server guards anyway.
  // -------------------------------------------------------------------------
  it("§7.4 questionnaire-answers without open questionnaire → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      const spy = vi.spyOn(executeTurnModule, "executeTurn");
      const promise = submitWaveTurn({
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
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 5. §7.4: stale questionnaireId (client has an old open questionnaire id).
  //    Reject before LLM call so the model doesn't see a mismatched envelope.
  // -------------------------------------------------------------------------
  it("§7.4 stale questionnaireId → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await seedOpenMcQuestionnaire(courseId, waveId);
      const spy = vi.spyOn(executeTurnModule, "executeTurn");
      const promise = submitWaveTurn({
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
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 5b. §7.4: answer count mismatch. The open questionnaire has 1 question;
  //     the learner submits 2 answers. Reject before LLM dispatch so the
  //     model never sees a mismatched envelope. Mirrors the "stale id"
  //     guard's structure — same code, different reason string.
  // -------------------------------------------------------------------------
  it("§7.4 answer count mismatch → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);
      const spy = vi.spyOn(executeTurnModule, "executeTurn");
      const promise = submitWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        // Open questionnaire has 1 question (q-mc); send 2 answers to trip the guard.
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
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Close-turn dispatch: pre-seed (WAVE.turnCount - 1) user_message rows so
  //    consumed = turnCount - 1 → turnsRemaining after this turn = 0. Verify
  //    `executeWaveClose` runs (kind: "close-turn"). We mock executeTurn to
  //    return a WaveCloseTurn payload because the close path uses the close
  //    schema, not the mid schema.
  // -------------------------------------------------------------------------
  it("close-turn dispatch: consumed = turnCount - 1 → executeWaveClose runs", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Pre-seed WAVE.turnCount - 1 user_message rows (one per past turn).
      // No assistant_response after the last user_message → no open
      // questionnaire to trip §7.4, and the chat-text branch is open.
      // Array-reduce instead of for/let to satisfy `functional/no-let`.
      await Array.from({ length: WAVE.turnCount - 1 }).reduce<Promise<void>>(
        async (accP, _v, i) => {
          await accP;
          await appendMessage({
            parent: { kind: "wave", id: waveId },
            turnIndex: i,
            seq: 0,
            kind: "user_message",
            role: "user",
            content: `<learner_reply>past turn ${i}</learner_reply>`,
          });
        },
        Promise.resolve(),
      );

      const closeParsed = makeCloseParsed();
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeMidTurnMock(
          closeParsed as unknown as WaveMidTurn,
        ) as unknown as typeof executeTurnModule.executeTurn,
      );

      const result = await submitWaveTurn({
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "last reply" },
      });

      expect(result.kind).toBe("close-turn");
      if (result.kind !== "close-turn") throw new Error("expected close-turn");
      expect(result.closingMessage).toBe("Closing chat.");
      expect(result.nextWaveNumber).toBe(2);
      // Sanity: the close turn persisted a final user_message → total
      // user_messages = WAVE.turnCount.
      const userRows = await db
        .select()
        .from(contextMessages)
        .where(eq(contextMessages.waveId, waveId));
      const userMessageCount = userRows.filter((r) => r.kind === "user_message").length;
      expect(userMessageCount).toBe(WAVE.turnCount);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Durability: when the LLM call fails (executeTurn rejects), the learner's
  //    chat-text MUST already be persisted to `waves.chat_log`. The
  //    context_messages user_message row, by contrast, only lands on LLM
  //    success (inside executeTurn's atomic batch), so the two stores
  //    intentionally diverge on the failure path — see ARCHITECTURE.md
  //    "per-store atomicity". Mirrors scoping's pre-LLM persistence pattern
  //    (`generateFramework.ts`, `submitBaseline.persist.ts`).
  // -------------------------------------------------------------------------
  it("persists learner chat-text to chat_log before executeWaveMid runs", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      vi.spyOn(executeTurnModule, "executeTurn").mockRejectedValueOnce(
        new Error("LLM transport failure"),
      );

      await expect(
        submitWaveTurn({
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: { kind: "chat-text", text: "Hello?" },
        }),
      ).rejects.toThrow("LLM transport failure");

      // chat_log: learner entry MUST survive the failure (pre-LLM write).
      const wave = await getWaveById(waveId);
      const log = wave.chatLog as WaveChatLog;
      const userEntries = log.filter((e) => e.role === "user" && e.kind === "text");
      expect(userEntries).toHaveLength(1);
      expect(userEntries[0]).toEqual({ role: "user", kind: "text", content: "Hello?" });

      // context_messages: user_message row must NOT be written when the LLM
      // rejected — executeTurn's atomic batch never ran.
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.filter((r) => r.kind === "user_message")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Same durability invariant for the questionnaire-answers branch:
  //    learner's submitted answers persist to chat_log pre-LLM so a transport
  //    failure can't drop them. The `{role: user, kind: answers, ...}` entry
  //    must contain a `responses` array shaped per WaveChatLogEntry's schema.
  // -------------------------------------------------------------------------
  it("persists learner questionnaire-answers to chat_log before executeWaveMid runs", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);
      vi.spyOn(executeTurnModule, "executeTurn").mockRejectedValueOnce(
        new Error("LLM transport failure"),
      );

      await expect(
        submitWaveTurn({
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: {
            kind: "questionnaire-answers",
            questionnaireId: questionnaireMsgId,
            answers: [{ id: "q-mc", kind: "mc", selected: "B" }],
          },
        }),
      ).rejects.toThrow("LLM transport failure");

      const wave = await getWaveById(waveId);
      const log = wave.chatLog as WaveChatLog;
      const userEntries = log.filter((e) => e.role === "user" && e.kind === "answers");
      expect(userEntries).toHaveLength(1);
      expect(userEntries[0]).toEqual({
        role: "user",
        kind: "answers",
        questionnaireId: questionnaireMsgId,
        responses: [{ questionId: "q-mc", choice: "B" }],
      });

      // No card_answer rows in context_messages on the failure path.
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.filter((r) => r.kind === "card_answer")).toHaveLength(0);
    });
  });
});
