import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles, assessments, concepts } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { appendWaveChatLog, openWave } from "@/db/queries/waves.writes";
import { getWaveById } from "@/db/queries/waves";
import { appendMessage } from "@/db/queries/contextMessages.writes";
import { getNextTurnIndex } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts.writes";
import { insertOpenAssessments } from "@/db/queries/assessments.open";
import { WAVE } from "@/lib/config/tuning";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { loadWaveContext } from "./loadWaveContext";
import { persistWaveMidTurn } from "./persistWaveMidTurn";
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
import { namespaceQuestionId } from "./namespaceQuestionId";
import type { SubmitTurnPayload } from "./buildLearnerInput";

/**
 * Integration tests for `persistWaveMidTurn`: the post-LLM transaction of a
 * mid-Wave turn. Real Postgres testcontainer; no LLM. Each test first
 * appends the `user_message + assistant_response` pair the turn runner
 * commits, then hands `persistWaveMidTurn` the turn's output — the shape
 * `streamWaveTurn` builds from the tool collector.
 *
 * Coverage:
 *   1. Prose-only turn → assistant prose persists, no new assessments.
 *   2. Signals against an MC + free-text questionnaire → assessments updated
 *      with grading + XP + userAnswer, no SM-2 mutation.
 *   2b. Signals for unanswered or unknown ids → skipped, rows untouched.
 *   3. New questionnaire → N placeholder assessments inserted with
 *      namespaced question_ids, concepts upserted.
 *   4. bug_004: two questionnaires reusing one raw id do not collide.
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
 * Append the turn's `user_message + assistant_response` pair at the next
 * turn_index, as the turn runner does before `persistWaveMidTurn` runs.
 * `persistWaveMidTurn` reads the latest assistant_response row back: its id
 * becomes the questionnaireId, its turn_index the assessments' turn.
 */
async function appendTurnRows(waveId: string, assistantContent: string): Promise<void> {
  const parent = { kind: "wave", id: waveId } as const;
  const turnIndex = await getNextTurnIndex(parent);
  await appendMessage({
    parent,
    turnIndex,
    seq: 0,
    kind: "user_message",
    role: "user",
    content: "<learner_reply>test</learner_reply>",
  });
  await appendMessage({
    parent,
    turnIndex,
    seq: 1,
    kind: "assistant_response",
    role: "assistant",
    content: assistantContent,
  });
}

/**
 * Seed an open questionnaire (1 MC + 1 free-text) on the wave by writing an
 * assistant_response at turn 1. Also inserts placeholder assessment rows whose
 * stored `question_id` is namespaced by the assistant row id
 * (`namespaceQuestionId`) — matching what `insertNewQuestionnaire` does in
 * production, so the grading-path lookups resolve them.
 *
 * Returns the concept ids (for SM-2 assertions) and the namespaced
 * `question_id` values so tests can query the rows back directly.
 */
async function seedOpenQuestionnaire(
  courseId: string,
  waveId: string,
): Promise<{
  readonly mcConceptId: string;
  readonly ftConceptId: string;
  readonly mcQuestionId: string;
  readonly ftQuestionId: string;
}> {
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
  const assistantRow = await appendMessage({
    parent: { kind: "wave", id: waveId },
    turnIndex: 1,
    seq: 0,
    kind: "assistant_response",
    role: "assistant",
    content: JSON.stringify(assistantPayload),
  });
  // Mirror the production dual-write: alongside the assistant_response row,
  // chat_log gets a `text_with_questionnaire` entry whose `questionnaireId`
  // matches the assistant_response row id. `findOpenQuestionnaire` (the
  // derivation source after Task 13) reads chat_log, not context_messages.
  await appendWaveChatLog(db, waveId, {
    role: "assistant",
    kind: "text_with_questionnaire",
    questionnaireId: assistantRow.id,
    content: assistantPayload.userMessage,
    questions: assistantPayload.questionnaire!.questions,
  });
  // Mirror the production flow: when the assistant emits a questionnaire, the
  // orchestrator inserts placeholder rows with `question_id` namespaced by the
  // assistant_response row id (`namespaceQuestionId`) so the grading lookups
  // resolve. The raw model ids stay `q-mc`/`q-ft` on chat_log above.
  const mcQuestionId = namespaceQuestionId(assistantRow.id, "q-mc");
  const ftQuestionId = namespaceQuestionId(assistantRow.id, "q-ft");
  await insertOpenAssessments({
    waveId,
    turnIndex: 1,
    rows: [
      {
        conceptId: conceptMc.id,
        questionId: mcQuestionId,
        question: "Pick the rule",
        assessmentKind: "card_mc",
      },
      {
        conceptId: conceptFt.id,
        questionId: ftQuestionId,
        question: "Explain borrowing",
        assessmentKind: "card_freetext",
      },
    ],
  });
  return { mcConceptId: conceptMc.id, ftConceptId: conceptFt.id, mcQuestionId, ftQuestionId };
}

describe("persistWaveMidTurn (integration)", () => {
  // ---------------------------------------------------------------------------
  // 1. Pure chat-text reply: teaching prose, no questionnaire. No assessment
  //    rows should be created or modified.
  // ---------------------------------------------------------------------------
  it("prose-only turn → assistant prose persists, no new assessments", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const parsed: WaveMidTurn = { userMessage: "Here is a teaching turn." };
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const payload: SubmitTurnPayload = { kind: "chat-text", text: "tell me more" };
      await appendTurnRows(waveId, parsed.userMessage);

      const result = await persistWaveMidTurn({ ctx, parsed, payload, turnsRemaining: 5 });

      expect(result.assistantContent).toBe("Here is a teaching turn.");
      expect(result.newQuestionnaire).toBeNull();
      expect(result.gradedSignals).toEqual([]);
      const rows = await db.select().from(assessments).where(eq(assessments.waveId, waveId));
      expect(rows).toHaveLength(0);
      // Dual-write invariant: assistant emission lands on chat_log too.
      // Cast to WaveChatLog because chat_log is typed `unknown` on the Drizzle
      // row (jsonb isn't parameterised; row guard validates on read).
      const waveRow = await getWaveById(waveId);
      const last = (waveRow.chatLog as WaveChatLog).at(-1);
      expect(last).toEqual({
        role: "assistant",
        kind: "text",
        content: parsed.userMessage,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Learner answers an MC (correct) + free-text against an open
  //    questionnaire. Model returns comprehensionSignals for both. Assessment
  //    rows must be updated with grading + XP + the learner's actual answer
  //    text replacing the "" placeholder.
  // ---------------------------------------------------------------------------
  it("signals for answered questions → grading + XP + userAnswer applied, no SM-2 mutation", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { mcConceptId, ftConceptId, mcQuestionId, ftQuestionId } = await seedOpenQuestionnaire(
        courseId,
        waveId,
      );
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
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const openQ = findOpenQuestionnaire(ctx.wave.chatLog as WaveChatLog);
      const payload: SubmitTurnPayload = {
        kind: "questionnaire-answers",
        questionnaireId: openQ!.questionnaireId,
        answers: [
          { id: "q-mc", kind: "mc", selected: "B" }, // matches `correct: "B"`
          { id: "q-ft", kind: "freetext", text: "borrow is a temporary loan", fromEscape: false },
        ],
      };
      await appendTurnRows(waveId, parsed.userMessage);

      const result = await persistWaveMidTurn({ ctx, parsed, payload, turnsRemaining: 4 });

      expect(result.gradedSignals).toHaveLength(2);
      // gradedSignals surface the RAW model id (what the client matches on),
      // even though the stored row is keyed on the namespaced id.
      expect(result.gradedSignals.map((s) => s.questionId).sort()).toEqual(["q-ft", "q-mc"]);
      // MC row: B vs correct=B → correct=true; xp = calculateMcXp(tier=1, true).
      // Rows are queried by the NAMESPACED `question_id` the insert path stored.
      const mcRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, mcQuestionId))
      )[0]!;
      expect(mcRow.isCorrect).toBe(true);
      expect(mcRow.qualityScore).toBe(4);
      expect(mcRow.xpAwarded).toBeGreaterThan(0);
      expect(mcRow.userAnswer).toBe("B");
      // Free-text row: partial verdict, q=3 → not isCorrect, xp from calculateXP(1,3).
      const ftRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, ftQuestionId))
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
      // Dual-write invariant: assistant emission (text-only this turn) lands
      // on chat_log too. No `questionnaire` field so the text-only arm fires.
      const waveRow = await getWaveById(waveId);
      const last = (waveRow.chatLog as WaveChatLog).at(-1);
      expect(last).toEqual({
        role: "assistant",
        kind: "text",
        content: parsed.userMessage,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 2b. Issue #144 guard: the grading tool stages any signal, so persistence
  //     must skip one the learner did not answer this Turn. The learner
  //     answers only q-mc. The model also grades q-ft (a real row, left
  //     unanswered) and q9 (no row). Only q-mc is graded.
  // ---------------------------------------------------------------------------
  it("signals for unanswered or unknown ids → skipped, their rows untouched", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const { ftQuestionId } = await seedOpenQuestionnaire(courseId, waveId);
      const ftRowOf = async () =>
        (await db.select().from(assessments).where(eq(assessments.questionId, ftQuestionId)))[0]!;
      const ftBefore = await ftRowOf();

      const parsed: WaveMidTurn = {
        userMessage: "Good pick.",
        comprehensionSignals: [
          { kind: "mc-index", questionId: "q-mc", rationale: "Right rule. Move on." },
          {
            kind: "free-text",
            questionId: "q-ft",
            verdict: "correct",
            qualityScore: 5,
            rationale: "Never answered. Must not land.",
          },
          { kind: "mc-index", questionId: "q9", rationale: "Unknown id. Must not land." },
        ],
      };
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const openQ = findOpenQuestionnaire(ctx.wave.chatLog as WaveChatLog);
      const payload: SubmitTurnPayload = {
        kind: "questionnaire-answers",
        questionnaireId: openQ!.questionnaireId,
        answers: [{ id: "q-mc", kind: "mc", selected: "B" }],
      };
      await appendTurnRows(waveId, parsed.userMessage);

      const result = await persistWaveMidTurn({ ctx, parsed, payload, turnsRemaining: 4 });

      expect(result.gradedSignals.map((s) => s.questionId)).toEqual(["q-mc"]);
      // The unanswered row keeps its placeholder state: no verdict, no XP.
      expect(await ftRowOf()).toEqual(ftBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. New questionnaire emitted in a turn that had no prior questionnaire.
  //    Expect N placeholder assessment rows, concepts upserted, projection
  //    carries correctEnc for MC.
  // ---------------------------------------------------------------------------
  it("new questionnaire → assessments inserted, concepts upserted, correctEnc set", async () => {
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
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const payload: SubmitTurnPayload = { kind: "chat-text", text: "ready" };
      await appendTurnRows(waveId, parsed.userMessage);

      const result = await persistWaveMidTurn({ ctx, parsed, payload, turnsRemaining: 6 });

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
      // Two assessment rows persisted. The stored `question_id` is namespaced
      // by the assistant_response row id (`namespaceQuestionId`) — the
      // projection still surfaces the raw `q-new-*` ids to the client.
      const rows = await db.select().from(assessments).where(eq(assessments.waveId, waveId));
      expect(rows).toHaveLength(2);
      const qnId = result.newQuestionnaire!.questionnaireId;
      const qids = rows.map((r) => r.questionId).sort();
      expect(qids).toEqual(
        [namespaceQuestionId(qnId, "q-new-ft"), namespaceQuestionId(qnId, "q-new-mc")].sort(),
      );
      // Every stored id is namespaced — none is the bare model id.
      expect(rows.every((r) => r.questionId?.startsWith(`${qnId}:`))).toBe(true);
      // Concepts upserted with the names from the questionnaire.
      const conceptRows = await db.select().from(concepts).where(eq(concepts.courseId, courseId));
      const conceptNames = conceptRows.map((c) => c.name).sort();
      expect(conceptNames).toEqual(["lifetimes", "moves"]);
      // Dual-write invariant: assistant emission with a new questionnaire
      // lands on chat_log as a `text_with_questionnaire` entry whose
      // questionnaireId matches the projection (both keyed off assistantRow.id).
      const waveRow = await getWaveById(waveId);
      const last = (waveRow.chatLog as WaveChatLog).at(-1);
      expect(last).toMatchObject({
        role: "assistant",
        kind: "text_with_questionnaire",
        content: parsed.userMessage,
        questionnaireId: result.newQuestionnaire!.questionnaireId,
        questions: parsed.questionnaire!.questions,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 4. bug_004 regression: the model reuses the SAME raw id (`q1`) across two
  //    questionnaires in one wave. Pre-fix, both rows tried to write
  //    `(wave_id, 'q1')` → the second turn 500s on the partial unique index
  //    `assessments_wave_question_unique`. Post-fix, each row's stored
  //    `question_id` is namespaced by its emitting assistant_response id, so
  //    both turns persist cleanly.
  // ---------------------------------------------------------------------------
  it("cross-turn id reuse: two questionnaires both using 'q1' persist without colliding", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();

      // Helper: one mid-turn that emits a single free-text question id `q1`.
      const makeQ1Turn = (prompt: string, conceptName: string): WaveMidTurn => ({
        userMessage: prompt,
        questionnaire: {
          questions: [
            {
              id: "q1",
              type: "free_text",
              prompt,
              freetextRubric: "rubric",
              conceptName,
              tier: 1,
            },
          ],
        },
      });

      // --- Turn 1: emit a questionnaire using `q1`. -------------------------
      const turn1 = makeQ1Turn("First check", "ownership");
      const ctx1 = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      await appendTurnRows(waveId, turn1.userMessage);
      const result1 = await persistWaveMidTurn({
        ctx: ctx1,
        parsed: turn1,
        payload: { kind: "chat-text", text: "ready" },
        turnsRemaining: 6,
      });
      expect(result1.newQuestionnaire).not.toBeNull();

      // --- Turn 2: emit ANOTHER questionnaire, ALSO using `q1`. -------------
      // Pre-fix this throws a 23505 unique-constraint violation.
      const turn2 = makeQ1Turn("Second check", "borrowing");
      const ctx2 = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      await appendTurnRows(waveId, turn2.userMessage);
      // Must NOT throw — the regression is a hard 500 here pre-fix.
      const result2 = await persistWaveMidTurn({
        ctx: ctx2,
        parsed: turn2,
        payload: { kind: "chat-text", text: "next" },
        turnsRemaining: 5,
      });
      expect(result2.newQuestionnaire).not.toBeNull();

      // Both questionnaires persisted: two assessment rows on the wave, each
      // surfacing the raw `q1` to the client but stored under distinct
      // namespaced `question_id`s keyed off their emitting questionnaire.
      const rows = await db.select().from(assessments).where(eq(assessments.waveId, waveId));
      expect(rows).toHaveLength(2);
      const storedIds = rows.map((r) => r.questionId).sort();
      expect(new Set(storedIds).size).toBe(2);
      expect(storedIds).toEqual(
        [
          namespaceQuestionId(result1.newQuestionnaire!.questionnaireId, "q1"),
          namespaceQuestionId(result2.newQuestionnaire!.questionnaireId, "q1"),
        ].sort(),
      );
      // The client-facing projection keeps the raw model id for both.
      expect(result1.newQuestionnaire!.questions[0]!.id).toBe("q1");
      expect(result2.newQuestionnaire!.questions[0]!.id).toBe("q1");
    });
  });
});
