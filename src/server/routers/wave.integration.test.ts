import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse, setCourseStartingState } from "@/db/queries/courses";
import { openWave, appendWaveChatLog } from "@/db/queries/waves";
import { appendMessage, getNextTurnIndex } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts";
import { insertOpenAssessments } from "@/db/queries/assessments";
import { WAVE } from "@/lib/config/tuning";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { ExecuteTurnParams, ExecuteTurnResult } from "@/lib/turn/executeTurn";
import { appRouter } from "./index";

/**
 * Integration tests for `wave.ts` — the tRPC transport for Task 14.
 *
 * Router-level coverage focuses on three things (per plan §13):
 *   1. Wire shape arrives intact through Zod input validation.
 *   2. Lib-layer return values surface to the caller.
 *   3. Lib-layer `TRPCError` codes (NOT_FOUND, PRECONDITION_FAILED) propagate.
 *
 * Heavy branch coverage of the lib steps already lives in
 * `submitWaveTurn.integration.test.ts`, `executeWaveMid.integration.test.ts`,
 * `executeWaveClose.integration.test.ts`, and `getWaveState.integration.test.ts`.
 * The tests below avoid duplicating that — we exercise the router seams only.
 *
 * Mock surface: `executeTurn` is mocked per-test via `vi.spyOn` so we don't
 * call the real LLM. Everything else (Postgres testcontainer, lib steps, DB
 * queries) is real. The mock persists user + assistant rows so downstream
 * grading + turn-counting code observes production-shaped context_messages.
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
  // Activate the course so the close-turn dispatch test can write totalXp
  // without tripping the status CHECK (totalXp updates require active status).
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
 * `executeTurn` mock — persists user + assistant rows at the next turn_index
 * (so any test pre-seed doesn't collide) and returns the supplied parsed
 * payload. Matches the patterns in `submitWaveTurn.integration.test.ts` /
 * `executeWaveClose.integration.test.ts`.
 */
function makeExecuteTurnMock<P>(parsed: P) {
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

/**
 * Seed an open MC questionnaire on the given wave + its placeholder assessment
 * row. The `questionnaireMsgId` returned is the assistant_response row id,
 * which `submitWaveTurn` expects as `payload.questionnaireId`.
 *
 * Mirrors `seedOpenMcQuestionnaire` in `submitWaveTurn.integration.test.ts`.
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
  // Mirror executeWaveMid's dual-write (T8): chat_log gains the
  // `text_with_questionnaire` entry whose `questionnaireId` matches the
  // assistant_response row id. `findOpenQuestionnaire` (the lib-side
  // open-questionnaire detection) reads chat_log only, so the fixture
  // must seed both stores to mirror production invariants.
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
        questionId: "q-mc",
        question: "Pick",
        assessmentKind: "card_mc",
      },
    ],
  });
  return { questionnaireMsgId: row.id };
}

/** Build a WaveCloseTurn parsed payload that satisfies `makeWaveCloseSchema`. */
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

beforeEach(() => {
  vi.restoreAllMocks();
});

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
      // from submitTurn (the field is a documentation handle for client union stability).
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

// ===========================================================================
// wave.submitTurn
// ===========================================================================

describe("wave.submitTurn", () => {
  // -------------------------------------------------------------------------
  // 3. chat-text mid-turn happy path — stub LLM returns a minimal valid
  //    `waveMidTurnSchema` payload (just userMessage). Verifies the discriminator
  //    `kind: "mid-turn"` and assistantContent surface to the router caller.
  // -------------------------------------------------------------------------
  it("chat-text mid-turn: returns mid-turn result", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      const parsed: WaveMidTurn = { userMessage: "Got it." };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const caller = appRouter.createCaller({ userId: USER_ID });
      const result = await caller.wave.submitTurn({
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "tell me more" },
      });

      expect(result.kind).toBe("mid-turn");
      if (result.kind !== "mid-turn") throw new Error("expected mid-turn");
      expect(result.assistantContent).toBe("Got it.");
      expect(result.newQuestionnaire).toBeNull();
      expect(result.turnsRemaining).toBe(WAVE.turnCount - 1);
    });
  });

  // -------------------------------------------------------------------------
  // 4. questionnaire-answers mid-turn happy path. Seeds an open MC questionnaire,
  //    submits the correct answer, asserts the gradedSignals projection arrives.
  // -------------------------------------------------------------------------
  it("questionnaire-answers mid-turn: grades the prior answer and returns mid-turn", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);
      // Model emits a comprehensionSignal for q-mc so grading runs server-side.
      const parsed: WaveMidTurn = {
        userMessage: "Right!",
        comprehensionSignals: [{ kind: "mc-index", questionId: "q-mc", rationale: "got it" }],
      };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const caller = appRouter.createCaller({ userId: USER_ID });
      const result = await caller.wave.submitTurn({
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
      expect(result.gradedSignals[0]).toMatchObject({ questionId: "q-mc", correct: true });
    });
  });

  // -------------------------------------------------------------------------
  // 5a. §7.4: chat-text rejected while a questionnaire is open. The lib layer
  //     throws TRPCError(PRECONDITION_FAILED) before any LLM call.
  // -------------------------------------------------------------------------
  it("§7.4 chat-text with open questionnaire → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await seedOpenMcQuestionnaire(courseId, waveId);
      // Spy on executeTurn so a regression past the guard fails loud.
      const spy = vi.spyOn(executeTurnModule, "executeTurn");

      const caller = appRouter.createCaller({ userId: USER_ID });
      const promise = caller.wave.submitTurn({
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
  // 5b. §7.4: questionnaire-answers without an open questionnaire.
  // -------------------------------------------------------------------------
  it("§7.4 questionnaire-answers without open questionnaire → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      const spy = vi.spyOn(executeTurnModule, "executeTurn");

      const caller = appRouter.createCaller({ userId: USER_ID });
      const promise = caller.wave.submitTurn({
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
  // 5c. §7.4: stale questionnaireId — the open questionnaire exists but the
  //     client carries an old id. Reject before LLM dispatch.
  // -------------------------------------------------------------------------
  it("§7.4 stale questionnaireId → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await seedOpenMcQuestionnaire(courseId, waveId);
      const spy = vi.spyOn(executeTurnModule, "executeTurn");

      const caller = appRouter.createCaller({ userId: USER_ID });
      const promise = caller.wave.submitTurn({
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
  // 5d. §7.4: answer count mismatch — open questionnaire has 1 question; the
  //     learner submits 2 answers.
  // -------------------------------------------------------------------------
  it("§7.4 answer count mismatch → PRECONDITION_FAILED", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { questionnaireMsgId } = await seedOpenMcQuestionnaire(courseId, waveId);
      const spy = vi.spyOn(executeTurnModule, "executeTurn");

      const caller = appRouter.createCaller({ userId: USER_ID });
      const promise = caller.wave.submitTurn({
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
      await expect(promise).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "answer count mismatch",
      });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Close-turn dispatch. Pre-seed (WAVE.turnCount - 1) user_message rows so
  //    consumed = turnCount - 1, this turn flips to close. The stub returns a
  //    WaveCloseTurn payload (executeWaveClose uses the close schema). Verify
  //    the close-turn discriminator + projected fields surface through tRPC.
  // -------------------------------------------------------------------------
  it("close-turn dispatch: consumed = turnCount - 1 → returns close-turn result", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Pre-seed (turnCount - 1) past learner turns. No assistant_response after
      // the last user_message → no open questionnaire (chat-text branch open).
      // Dual-write to both context_messages (LLM replay log) and chat_log
      // (the UI/turn-budget source) — post-T11 `submitWaveTurn` derives
      // `consumed` from chat_log, so close-turn dispatch requires the
      // chat_log user entries to be present.
      // Array.reduce instead of for/let to satisfy `functional/no-let`.
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
          await appendWaveChatLog(db, waveId, {
            role: "user",
            kind: "text",
            content: `past turn ${i}`,
          });
        },
        Promise.resolve(),
      );

      const closeParsed = makeCloseParsed();
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(closeParsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const caller = appRouter.createCaller({ userId: USER_ID });
      const result = await caller.wave.submitTurn({
        courseId,
        waveNumber: 1,
        payload: { kind: "chat-text", text: "last reply" },
      });

      expect(result.kind).toBe("close-turn");
      if (result.kind !== "close-turn") throw new Error("expected close-turn");
      expect(result.closingMessage).toBe("Closing chat.");
      expect(result.nextWaveNumber).toBe(2);
      expect(result.nextWaveId).toBeTruthy();
    });
  });
});
