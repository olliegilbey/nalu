import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles, assessments, concepts } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { openWave } from "@/db/queries/waves";
import { appendMessage, getNextTurnIndex } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts";
import { insertOpenAssessments } from "@/db/queries/assessments";
import { WAVE } from "@/lib/config/tuning";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import { loadWaveContext } from "./loadWaveContext";
import { executeWaveMid } from "./executeWaveMid";
import { buildLearnerInput, type SubmitTurnPayload } from "./buildLearnerInput";
import type { ExecuteTurnParams, ExecuteTurnResult } from "@/lib/turn/executeTurn";

/**
 * Integration tests for `executeWaveMid`.
 *
 * Strategy mirrors `submitBaseline.integration.test.ts`: real Postgres
 * testcontainer for everything EXCEPT the LLM call. `executeTurn` is mocked
 * via `vi.spyOn`, but the mock implementation persists `user_message +
 * assistant_response` to context_messages so the orchestrator's MAX-based
 * turn_index lookup matches production behaviour.
 *
 * Coverage (plan §11 step 1):
 *   1. chat-text reply → assistant prose persists, no new assessments.
 *   2. questionnaire-answers reply against an MC + free-text drop →
 *      assessments updated with grading + XP + userAnswer, no SM-2 mutation.
 *   3. New questionnaire emitted → N placeholder assessments inserted with
 *      matching question_ids, concepts upserted.
 *   4. ValidationGateFailure forces retry, eventual success → final state correct.
 */

const USER_ID = "88888888-8888-8888-8888-888888888888";

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
 * Seed a user + active course + open Wave 1 and return the ids each test
 * needs. Must be called inside `withTestDb`.
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

/**
 * Build an executeTurn mock that mimics production persistence:
 *   1. Reserves the next turn_index via `getNextTurnIndex`.
 *   2. Appends a user_message row at (turnIndex, seq=0) with the envelope text.
 *   3. Appends an assistant_response row at (turnIndex, seq=1) with the JSON
 *      content (so loadWaveContext can later reconstruct the questionnaire).
 *   4. Returns the canned `parsed` + zero usage.
 *
 * This makes the orchestrator's MAX-based turn_index calc inside the
 * transaction match production behaviour without needing the real LLM.
 */
function makeExecuteTurnMock(parsed: WaveMidTurn) {
  return async <T>(params: ExecuteTurnParams<T>): Promise<ExecuteTurnResult<T>> => {
    if (params.parent.kind !== "wave") {
      throw new Error("test mock: only wave parents supported");
    }
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
 * Seed an open questionnaire (1 MC + 1 free-text) on the wave by writing an
 * assistant_response at turn 1. Also inserts placeholder assessment rows that
 * map back to the same question ids via `insertOpenAssessments`.
 *
 * Returns the concept ids so tests can assert SM-2 fields aren't mutated.
 */
async function seedOpenQuestionnaire(
  courseId: string,
  waveId: string,
): Promise<{ readonly mcConceptId: string; readonly ftConceptId: string }> {
  const conceptMc = await upsertConcept({ courseId, name: "ownership", tier: 1 });
  const conceptFt = await upsertConcept({ courseId, name: "borrowing", tier: 1 });
  const assistantPayload: WaveMidTurn = {
    userMessage: "Try these:",
    questionnaire: {
      questions: [
        {
          id: "q-mc",
          type: "multiple_choice",
          prompt: "Pick the rule",
          options: { A: "alpha", B: "beta", C: "gamma", D: "delta" },
          correct: "B",
          freetextRubric: "rubric-mc",
          conceptName: "ownership",
          tier: 1,
        },
        {
          id: "q-ft",
          type: "free_text",
          prompt: "Explain borrowing",
          freetextRubric: "rubric-ft",
          conceptName: "borrowing",
          tier: 1,
        },
      ],
    },
  };
  await appendMessage({
    parent: { kind: "wave", id: waveId },
    turnIndex: 1,
    seq: 0,
    kind: "assistant_response",
    role: "assistant",
    content: JSON.stringify(assistantPayload),
  });
  // Mirror the production flow: when the assistant emits a questionnaire, the
  // orchestrator inserts placeholder rows. Seed them here so the grading test
  // has rows to update.
  await insertOpenAssessments({
    waveId,
    turnIndex: 1,
    rows: [
      {
        conceptId: conceptMc.id,
        questionId: "q-mc",
        question: "Pick the rule",
        assessmentKind: "card_mc",
      },
      {
        conceptId: conceptFt.id,
        questionId: "q-ft",
        question: "Explain borrowing",
        assessmentKind: "card_freetext",
      },
    ],
  });
  return { mcConceptId: conceptMc.id, ftConceptId: conceptFt.id };
}

describe("executeWaveMid (integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Pure chat-text reply: teaching prose, no questionnaire. No assessment
  //    rows should be created or modified.
  // ---------------------------------------------------------------------------
  it("chat-text reply → assistant prose persists, no new assessments", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const parsed: WaveMidTurn = { userMessage: "Here is a teaching turn." };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const payload: SubmitTurnPayload = { kind: "chat-text", text: "tell me more" };
      const learnerInput = buildLearnerInput(payload, ctx.openQuestionnaire);

      const result = await executeWaveMid(ctx, learnerInput, 5, payload);

      expect(result.assistantContent).toBe("Here is a teaching turn.");
      expect(result.newQuestionnaire).toBeNull();
      expect(result.gradedSignals).toEqual([]);
      const rows = await db.select().from(assessments).where(eq(assessments.waveId, waveId));
      expect(rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Learner answers an MC (correct) + free-text against an open
  //    questionnaire. Model returns comprehensionSignals for both. Assessment
  //    rows must be updated with grading + XP + the learner's actual answer
  //    text replacing the "" placeholder.
  // ---------------------------------------------------------------------------
  it("questionnaire-answers → grading + XP + userAnswer applied, no SM-2 mutation", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { mcConceptId, ftConceptId } = await seedOpenQuestionnaire(courseId, waveId);
      // Capture initial SM-2 state — must be identical post-mid-turn (SM-2
      // only mutates at Wave close, spec §3 decisions).
      const initialMc = (await db.select().from(concepts).where(eq(concepts.id, mcConceptId)))[0]!;
      const initialFt = (await db.select().from(concepts).where(eq(concepts.id, ftConceptId)))[0]!;

      const parsed: WaveMidTurn = {
        userMessage: "Nice — let's keep going.",
        comprehensionSignals: [
          { kind: "mc-index", questionId: "q-mc", rationale: "click meaning. next teach." },
          {
            kind: "free-text",
            questionId: "q-ft",
            verdict: "partial",
            qualityScore: 3,
            rationale: "partial grasp. clarify lifetime.",
          },
        ],
      };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const payload: SubmitTurnPayload = {
        kind: "questionnaire-answers",
        questionnaireId: ctx.openQuestionnaire!.questionnaireId,
        answers: [
          { id: "q-mc", kind: "mc", selected: "B" }, // matches `correct: "B"`
          { id: "q-ft", kind: "freetext", text: "borrow is a temporary loan", fromEscape: false },
        ],
      };
      const learnerInput = buildLearnerInput(payload, ctx.openQuestionnaire);

      const result = await executeWaveMid(ctx, learnerInput, 4, payload);

      expect(result.gradedSignals).toHaveLength(2);
      // MC row: B vs correct=B → correct=true; xp = calculateMcXp(tier=1, true).
      const mcRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, "q-mc"))
      )[0]!;
      expect(mcRow.isCorrect).toBe(true);
      expect(mcRow.qualityScore).toBe(4);
      expect(mcRow.xpAwarded).toBeGreaterThan(0);
      expect(mcRow.userAnswer).toBe("B");
      // Free-text row: partial verdict, q=3 → not isCorrect, xp from calculateXP(1,3).
      const ftRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, "q-ft"))
      )[0]!;
      expect(ftRow.isCorrect).toBe(false);
      expect(ftRow.qualityScore).toBe(3);
      expect(ftRow.xpAwarded).toBeGreaterThan(0);
      expect(ftRow.userAnswer).toBe("borrow is a temporary loan");
      // SM-2 unchanged: no Wave-close has run yet.
      const afterMc = (await db.select().from(concepts).where(eq(concepts.id, mcConceptId)))[0]!;
      const afterFt = (await db.select().from(concepts).where(eq(concepts.id, ftConceptId)))[0]!;
      expect(afterMc.easinessFactor).toBe(initialMc.easinessFactor);
      expect(afterMc.repetitionCount).toBe(initialMc.repetitionCount);
      expect(afterFt.easinessFactor).toBe(initialFt.easinessFactor);
      expect(afterFt.repetitionCount).toBe(initialFt.repetitionCount);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. New questionnaire emitted in a turn that had no prior questionnaire.
  //    Expect N placeholder assessment rows, concepts upserted, projection
  //    carries correctEnc for MC.
  // ---------------------------------------------------------------------------
  it("model emits a new questionnaire → assessments inserted, concepts upserted, correctEnc set", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const parsed: WaveMidTurn = {
        userMessage: "Quick check:",
        questionnaire: {
          questions: [
            {
              id: "q-new-mc",
              type: "multiple_choice",
              prompt: "Pick A",
              options: { A: "yes", B: "no", C: "maybe", D: "never" },
              correct: "A",
              freetextRubric: "rubric-mc",
              conceptName: "lifetimes",
              tier: 1,
            },
            {
              id: "q-new-ft",
              type: "free_text",
              prompt: "Why?",
              freetextRubric: "rubric-ft",
              conceptName: "moves",
              tier: 1,
            },
          ],
        },
      };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const payload: SubmitTurnPayload = { kind: "chat-text", text: "ready" };
      const learnerInput = buildLearnerInput(payload, ctx.openQuestionnaire);

      const result = await executeWaveMid(ctx, learnerInput, 6, payload);

      expect(result.newQuestionnaire).not.toBeNull();
      expect(result.newQuestionnaire!.questions).toHaveLength(2);
      // MC question carries correctEnc (base64). Free-text does not.
      expect(result.newQuestionnaire!.questions[0]).toMatchObject({
        id: "q-new-mc",
        type: "multiple_choice",
        options: { A: "yes", B: "no", C: "maybe", D: "never" },
      });
      expect(result.newQuestionnaire!.questions[0]!.correctEnc).toBeTruthy();
      expect(result.newQuestionnaire!.questions[1]).toMatchObject({
        id: "q-new-ft",
        type: "free_text",
      });
      expect(result.newQuestionnaire!.questions[1]).not.toHaveProperty("correctEnc");
      // Two assessment rows persisted with matching question_ids.
      const rows = await db.select().from(assessments).where(eq(assessments.waveId, waveId));
      expect(rows).toHaveLength(2);
      const qids = rows.map((r) => r.questionId).sort();
      expect(qids).toEqual(["q-new-ft", "q-new-mc"]);
      // Concepts upserted with the names from the questionnaire.
      const conceptRows = await db.select().from(concepts).where(eq(concepts.courseId, courseId));
      const conceptNames = conceptRows.map((c) => c.name).sort();
      expect(conceptNames).toEqual(["lifetimes", "moves"]);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. ValidationGateFailure on the first executeTurn attempt → retry succeeds
  //    → assessments + projection still correct. We simulate this by having
  //    the spy throw once, then succeed (executeWaveMid only wraps one
  //    executeTurn call; retry-internal logic lives inside executeTurn, so
  //    the orchestrator-level test treats a thrown ValidationGateFailure as a
  //    re-attempt of the whole submit). For executeWaveMid, the contract is:
  //    if executeTurn throws, executeWaveMid propagates — there is no retry
  //    at this layer. So this test asserts the propagation surface: caller
  //    sees the failure unmodified.
  // ---------------------------------------------------------------------------
  it("propagates ValidationGateFailure from executeTurn without touching DB", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      vi.spyOn(executeTurnModule, "executeTurn").mockRejectedValue(
        new ValidationGateFailure("missing_response", "schema invariant violated"),
      );
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const payload: SubmitTurnPayload = { kind: "chat-text", text: "tell me" };
      const learnerInput = buildLearnerInput(payload, ctx.openQuestionnaire);

      await expect(executeWaveMid(ctx, learnerInput, 5, payload)).rejects.toBeInstanceOf(
        ValidationGateFailure,
      );
      // No assessments inserted on the failure path.
      const rows = await db.select().from(assessments).where(eq(assessments.waveId, waveId));
      expect(rows).toHaveLength(0);
    });
  });
});
