import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles, assessments, concepts, waves, courses } from "@/db/schema";
import { createCourse, setCourseStartingState } from "@/db/queries/courses";
import { openWave, getWaveByCourseAndNumber, appendWaveChatLog } from "@/db/queries/waves";
import { appendMessage, getMessagesForWave, getNextTurnIndex } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts";
import { insertOpenAssessments } from "@/db/queries/assessments";
import { WAVE } from "@/lib/config/tuning";
import { calculateXP } from "@/lib/scoring/xp";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { loadWaveContext } from "./loadWaveContext";
import { executeWaveClose } from "./executeWaveClose";
import { namespaceQuestionId } from "./namespaceQuestionId";
import type { ExecuteTurnParams, ExecuteTurnResult } from "@/lib/turn/executeTurn";

/**
 * Integration tests for `executeWaveClose`.
 *
 * Mirrors `executeWaveMid.integration.test.ts`: real Postgres testcontainer
 * except for the LLM call (`vi.spyOn(executeTurn)`). The mock persists user +
 * assistant rows so context_messages reflects production semantics, then the
 * orchestrator's persistence transaction runs end-to-end.
 *
 * Coverage (plan §12 step 1):
 *   1. Happy path: one free-text grading + one conceptUpdate. Assessment row
 *      updated, concept SM-2 advanced, Wave N closed, Wave N+1 opened from the
 *      blueprint with the openingText as turn-0 message, completion XP added.
 *   2. Consolidation Wave (empty plannedConcepts) on an odd-numbered wave →
 *      tier-advancement check runs unconditionally (the consolidation gate
 *      overrides the modulo gate). Tier doesn't actually advance (concept
 *      threshold unmet) but the gate path is exercised.
 *   3. Gated tier check: Wave 2 with tierCheckInterval=2 → modulo gate open.
 *      Pre-seed 5 passing concepts at tier 1 so checkTierAdvancement returns
 *      canAdvance=true; assert currentTier increments and Wave 3 opens at it.
 *   4. Concurrent close attempt: a pre-existing `wave_number = N+1` row trips
 *      the `(course_id, wave_number)` unique index when openWave runs inside
 *      the tx — the whole transaction rolls back, no orphan state.
 */

const USER_ID = "99999999-9999-9999-9999-999999999999";

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
 * Seed user + active course + open Wave N. Returns the ids the test needs to
 * dispatch into `executeWaveClose`. Must run inside `withTestDb`.
 *
 * `waveNumber` parameterised so tests can exercise the modulo-gated tier check.
 */
async function seedCourseWithOpenWave(
  waveNumber: number,
): Promise<{ readonly courseId: string; readonly waveId: string }> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  // Activate the course so summary/tiers exist — Wave open requires nothing
  // beyond the FK, but `setCourseStartingState` keeps the course shape consistent
  // with what the post-scoping state would look like in production.
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
 * Seed an open questionnaire on the wave AND its placeholder assessment row.
 * Returns the concept id (for SM-2 assertions) and the namespaced
 * `question_id` so tests can query the row back directly.
 *
 * Mirrors `seedOpenQuestionnaire` in `executeWaveMid.integration.test.ts` but
 * close-turn focused: only one free-text question is needed. Writes BOTH the
 * `context_messages` assistant_response AND the `chat_log`
 * `text_with_questionnaire` entry — `findOpenQuestionnaire` (used by
 * `executeWaveClose` and now `applyCloseGradings`) derives the open
 * questionnaire from `chat_log`, and its `questionnaireId` namespaces the
 * stored `question_id` (`namespaceQuestionId`).
 */
async function seedOpenFreeTextQuestionnaire(
  courseId: string,
  waveId: string,
  conceptName = "ownership",
  conceptTier = 1,
): Promise<{ readonly conceptId: string; readonly questionId: string }> {
  const concept = await upsertConcept({ courseId, name: conceptName, tier: conceptTier });
  // Seed the assistant_response so loadWaveContext reconstructs `openQuestionnaire`.
  const assistantPayload = {
    userMessage: "Final question:",
    questionnaire: {
      questions: [
        {
          id: "q-close",
          type: "free_text" as const,
          prompt: "Explain ownership in one sentence",
          freetextRubric: "rubric",
          conceptName,
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
  // Mirror the production dual-write: chat_log carries a `text_with_questionnaire`
  // entry whose `questionnaireId` matches the assistant_response row id.
  // `findOpenQuestionnaire` reads chat_log; `applyCloseGradings` re-derives the
  // namespaced `question_id` from this id.
  await appendWaveChatLog(db, waveId, {
    role: "assistant",
    kind: "text_with_questionnaire",
    questionnaireId: assistantRow.id,
    content: assistantPayload.userMessage,
    questions: assistantPayload.questionnaire.questions,
  });
  // Insert the placeholder assessment row the mid-turn flow would have written.
  // The stored `question_id` is namespaced by the questionnaire id — matching
  // `insertNewQuestionnaire` in production. The close transaction updates it
  // via applyAssessmentGrading.
  const questionId = namespaceQuestionId(assistantRow.id, "q-close");
  await insertOpenAssessments({
    waveId,
    turnIndex: 1,
    rows: [
      {
        conceptId: concept.id,
        questionId,
        question: "Explain ownership in one sentence",
        assessmentKind: "card_freetext",
      },
    ],
  });
  return { conceptId: concept.id, questionId };
}

/**
 * Seed an OPEN MC questionnaire on the wave plus its placeholder `card_mc`
 * assessment row. Does NOT write the learner's answer — that must land AFTER
 * `loadWaveContext` snapshots `ctx.wave.chatLog` (see `appendCloseMcAnswer`),
 * because in production `submitWaveTurn` appends it post-snapshot.
 *
 * bug_003: a questionnaire posed on the FINAL mid-turn has no later mid-turn,
 * so its MC question is answered — and graded — at close.
 *
 * Returns the `questionnaireId` (so the test can append the matching answer),
 * the concept id, and the namespaced stored `question_id`.
 */
async function seedOpenMcQuestionnaire(
  courseId: string,
  waveId: string,
  opts: { readonly correct: "A" | "B" | "C" | "D"; readonly conceptName?: string },
): Promise<{
  readonly conceptId: string;
  readonly questionId: string;
  readonly questionnaireId: string;
}> {
  const conceptName = opts.conceptName ?? "ownership";
  const concept = await upsertConcept({ courseId, name: conceptName, tier: 1 });
  const assistantPayload = {
    userMessage: "Final question:",
    questionnaire: {
      questions: [
        {
          id: "q-mc",
          type: "multiple_choice" as const,
          prompt: "Which keyword transfers ownership?",
          options: { A: "let", B: "move", C: "ref", D: "copy" },
          correct: opts.correct,
          freetextRubric: "rubric",
          conceptName,
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
  // chat_log carries the assistant's `text_with_questionnaire` entry —
  // `findOpenQuestionnaire` reads it for the server-side `correct` key.
  await appendWaveChatLog(db, waveId, {
    role: "assistant",
    kind: "text_with_questionnaire",
    questionnaireId: assistantRow.id,
    content: assistantPayload.userMessage,
    questions: assistantPayload.questionnaire.questions,
  });
  // Placeholder `card_mc` row the mid-turn flow would have inserted.
  const questionId = namespaceQuestionId(assistantRow.id, "q-mc");
  await insertOpenAssessments({
    waveId,
    turnIndex: 1,
    rows: [
      {
        conceptId: concept.id,
        questionId,
        question: assistantPayload.questionnaire.questions[0]!.prompt,
        assessmentKind: "card_mc",
      },
    ],
  });
  return { conceptId: concept.id, questionId, questionnaireId: assistantRow.id };
}

/**
 * Append the learner's close-turn MC click to the LIVE `chat_log`. Production
 * `submitWaveTurn` does this pre-LLM, AFTER `loadWaveContext` has snapshotted
 * `ctx.wave.chatLog` — so tests must call this between `loadWaveContext` and
 * `executeWaveClose` to faithfully reproduce the bug_003 path: the snapshot
 * still sees the questionnaire as OPEN; `applyCloseGradings` re-reads the live
 * column to find the click.
 */
async function appendCloseMcAnswer(
  waveId: string,
  questionnaireId: string,
  clicked: "A" | "B" | "C" | "D",
): Promise<void> {
  await appendWaveChatLog(db, waveId, {
    role: "user",
    kind: "answers",
    questionnaireId,
    responses: [{ questionId: "q-mc", choice: clicked }],
  });
}

/**
 * Build an executeTurn mock that mimics production persistence.
 *
 * The mock allocates the next turn index via `getNextTurnIndex` (matching the
 * mid-turn integration test) so any context_messages already written by test
 * setup don't collide. Writes a user_message at seq 0 and an assistant_response
 * at seq 1 against that turn. The orchestrator doesn't currently read the
 * assistant_response back after `executeTurn`, but persisting it keeps the
 * message log realistic for any test that walks it.
 */
function makeExecuteTurnMock(parsed: WaveCloseTurn) {
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

/** Default parsed WaveCloseTurn payload; `overrides` lets tests tweak per scenario. */
function makeParsedClose(
  overrides: {
    readonly gradings?: WaveCloseTurn["gradings"];
    readonly conceptUpdates?: WaveCloseTurn["conceptUpdates"];
    readonly plannedConcepts?: WaveCloseTurn["nextUnitBlueprint"]["plannedConcepts"];
  } = {},
): WaveCloseTurn {
  return {
    userMessage: "Closing chat.",
    summary: "We covered ownership.",
    gradings: overrides.gradings ?? [
      {
        kind: "free-text",
        questionId: "q-close",
        verdict: "correct",
        qualityScore: 5,
        conceptName: "ownership",
        conceptTier: 1,
        rationale: "captured it. move on.",
      },
    ],
    nextUnitBlueprint: {
      topic: "Borrowing rules",
      outline: ["borrow", "lifetimes"],
      openingText: "Welcome to lesson 2.",
      plannedConcepts: overrides.plannedConcepts ?? [{ name: "ownership", tier: 1, role: "fresh" }],
    },
    conceptUpdates: overrides.conceptUpdates ?? [
      { name: "ownership", qualityScore: 5, reason: "Demonstrated strong grasp this lesson." },
    ],
  };
}

describe("executeWaveClose (integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path: one free-text grading + one conceptUpdate. Wave 2 → modulo
  //    gate open under tierCheckInterval=2, but only 1 concept on tier 1 so
  //    advancement threshold unmet. Validates the full close pipeline.
  // ---------------------------------------------------------------------------
  it("happy path: grades free-text, advances SM-2, closes Wave N, opens Wave N+1 with completion XP", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      const { conceptId, questionId } = await seedOpenFreeTextQuestionnaire(courseId, waveId);
      const initialConcept = (
        await db.select().from(concepts).where(eq(concepts.id, conceptId))
      )[0]!;

      const parsed = makeParsedClose();
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const result = await executeWaveClose(ctx, "<learner_reply>final</learner_reply>");

      // Result-level assertions ---------------------------------------------
      expect(result.kind).toBe("close-turn");
      expect(result.closingMessage).toBe("Closing chat.");
      expect(result.nextWaveNumber).toBe(3);
      expect(result.completionXpAwarded).toBe(WAVE.completionXp);
      expect(result.gradedSignals).toHaveLength(1);
      // gradedSignals surface the RAW model id (`q-close`), even though the
      // stored row is keyed on the namespaced `question_id`.
      expect(result.gradedSignals[0]).toMatchObject({ kind: "free-text", questionId: "q-close" });
      expect(result.gradedSignals[0]!.xpAwarded).toBeGreaterThan(0);

      // Assessment row updated: verdict + quality_score persisted. Queried by
      // the NAMESPACED `question_id` the seed/insert path stored.
      const assessmentRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, questionId))
      )[0]!;
      expect(assessmentRow.isCorrect).toBe(true);
      expect(assessmentRow.qualityScore).toBe(5);
      expect(assessmentRow.xpAwarded).toBeGreaterThan(0);

      // Concept SM-2 advanced (repetitionCount bumped, nextReviewAt set) ----
      const afterConcept = (await db.select().from(concepts).where(eq(concepts.id, conceptId)))[0]!;
      expect(afterConcept.repetitionCount).toBe(initialConcept.repetitionCount + 1);
      expect(afterConcept.lastQualityScore).toBe(5);
      expect(afterConcept.nextReviewAt).not.toBeNull();

      // Wave N closed -------------------------------------------------------
      const closedWave = (await db.select().from(waves).where(eq(waves.id, waveId)))[0]!;
      expect(closedWave.status).toBe("closed");
      expect(closedWave.summary).toBe("We covered ownership.");
      expect(closedWave.blueprintEmitted).toMatchObject({ topic: "Borrowing rules" });

      // Wave N+1 opened with prior_blueprint seed source --------------------
      const allWaves = await db.select().from(waves).where(eq(waves.courseId, courseId));
      expect(allWaves).toHaveLength(2);
      const nextWave = allWaves.find((w) => w.waveNumber === 3)!;
      expect(nextWave.status).toBe("open");
      expect(nextWave.seedSource).toMatchObject({
        kind: "prior_blueprint",
        priorWaveId: waveId,
        blueprint: { topic: "Borrowing rules", openingText: "Welcome to lesson 2." },
      });
      // Fix 2: orchestrator must surface the new wave's row id so the upstream
      // `submitWaveTurn` (Task 13) can redirect/refresh the client.
      expect(result.nextWaveId).toBe(nextWave.id);

      // Turn-0 assistant message on Wave N+1 carrying openingText -----------
      const nextWaveMessages = await getMessagesForWave(nextWave.id);
      expect(nextWaveMessages).toHaveLength(1);
      expect(nextWaveMessages[0]).toMatchObject({
        role: "assistant",
        kind: "assistant_response",
        content: "Welcome to lesson 2.",
        turnIndex: 0,
        seq: 0,
      });

      // Completion XP applied to courses.total_xp ---------------------------
      const afterCourse = (await db.select().from(courses).where(eq(courses.id, courseId)))[0]!;
      expect(afterCourse.totalXp).toBe(WAVE.completionXp);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Consolidation Wave: plannedConcepts is empty. Even on Wave 1 (modulo gate
  //    closed under tierCheckInterval=2), the consolidation gate forces the tier
  //    check to run. tierAdvancedTo is null because the concept count threshold
  //    isn't met (minimumConceptsPerTier=5), but the *check ran*; the result
  //    flows back without a thrown error and Wave 2 opens cleanly.
  // ---------------------------------------------------------------------------
  it("consolidation (empty plannedConcepts) forces tier-check unconditionally", async () => {
    await withTestDb(async () => {
      // Wave 1 with tierCheckInterval=2: modulo gate is closed (1 % 2 !== 0).
      const { courseId, waveId } = await seedCourseWithOpenWave(1);
      await seedOpenFreeTextQuestionnaire(courseId, waveId);

      const parsed = makeParsedClose({ plannedConcepts: [] });
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const result = await executeWaveClose(ctx, "<learner_reply>x</learner_reply>");

      expect(result.tierAdvancedTo).toBeNull();
      expect(result.nextWaveNumber).toBe(2);
      const nextWave = (await db.select().from(waves).where(eq(waves.courseId, courseId))).find(
        (w) => w.waveNumber === 2,
      )!;
      expect(nextWave.tier).toBe(1);
      expect(result.nextWaveId).toBe(nextWave.id);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Gated tier check: Wave 2 (modulo gate open). Pre-seed 5 passing concepts
  //    at tier 1 so checkTierAdvancement returns canAdvance=true; assert tier
  //    increments to 2 and Wave 3 opens at the new tier.
  // ---------------------------------------------------------------------------
  it("gated tier check: Wave 2 (modulo open) with sufficient mastery advances current_tier", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      await seedOpenFreeTextQuestionnaire(courseId, waveId);
      // Seed 5 passed concepts at tier 1 — bumps lastQualityScore to 4 in one
      // statement so the count meets PROGRESSION.minimumConceptsPerTier.
      // Array+await reduce to satisfy `functional/no-let` (no for/let loops).
      await [0, 1, 2, 3, 4].reduce<Promise<void>>(async (accP, i) => {
        await accP;
        await upsertConcept({ courseId, name: `passed-${i}`, tier: 1 });
      }, Promise.resolve());
      await db.execute(
        sql`UPDATE concepts SET last_quality_score = 4 WHERE course_id = ${courseId} AND name LIKE 'passed-%'`,
      );

      const parsed = makeParsedClose();
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const result = await executeWaveClose(ctx, "<learner_reply>x</learner_reply>");

      expect(result.tierAdvancedTo).toBe(2);
      const afterCourse = (await db.select().from(courses).where(eq(courses.id, courseId)))[0]!;
      expect(afterCourse.currentTier).toBe(2);
      const nextWave = (await db.select().from(waves).where(eq(waves.courseId, courseId))).find(
        (w) => w.waveNumber === 3,
      )!;
      expect(nextWave.tier).toBe(2);
      expect(result.nextWaveId).toBe(nextWave.id);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Concurrent close attempt: pre-insert a `wave_number = N+1` row directly
  //    (status='closed' so it doesn't fight the partial open-index). The
  //    `waves_course_wave_number_unique` index then rejects openWave(N+1)
  //    inside the orchestrator's tx — everything rolls back: Wave N stays open,
  //    assessment row stays at placeholder, concept SM-2 untouched, XP at 0.
  // ---------------------------------------------------------------------------
  it("rolls back on (course_id, wave_number) unique violation when N+1 slot is taken", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      const { conceptId, questionId } = await seedOpenFreeTextQuestionnaire(courseId, waveId);
      const initialConcept = (
        await db.select().from(concepts).where(eq(concepts.id, conceptId))
      )[0]!;
      // Pre-occupy wave_number=3 with a closed row. This won't fight the partial
      // open-index, but `(course_id, wave_number)` is unique → the orchestrator's
      // openWave(3) inside the tx will throw a unique-violation.
      await db.insert(waves).values({
        courseId,
        waveNumber: 3,
        tier: 1,
        frameworkSnapshot: FRAMEWORK,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: [],
        seedSource: {
          kind: "scoping_handoff",
          blueprint: {
            topic: "pre",
            outline: ["x"],
            openingText: "p",
            plannedConcepts: [],
          },
        },
        turnBudget: WAVE.turnCount,
        status: "closed",
        closedAt: new Date(),
      });

      const parsed = makeParsedClose();
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      await expect(executeWaveClose(ctx, "<learner_reply>x</learner_reply>")).rejects.toThrow();

      // Wave N (2) must still be OPEN — the close was rolled back.
      const waveRow = (await db.select().from(waves).where(eq(waves.id, waveId)))[0]!;
      expect(waveRow.status).toBe("open");
      // Assessment row was NOT updated past placeholder grading. Queried by
      // the namespaced `question_id`.
      const assessmentRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, questionId))
      )[0]!;
      expect(assessmentRow.qualityScore).toBe(0);
      // Concept SM-2 unchanged.
      const afterConcept = (await db.select().from(concepts).where(eq(concepts.id, conceptId)))[0]!;
      expect(afterConcept.repetitionCount).toBe(initialConcept.repetitionCount);
      expect(afterConcept.lastQualityScore).toBe(initialConcept.lastQualityScore);
      // XP not incremented.
      const afterCourse = (await db.select().from(courses).where(eq(courses.id, courseId)))[0]!;
      expect(afterCourse.totalXp).toBe(0);

      // Fix 5: executeTurn's user_message + assistant_response rows sit OUTSIDE
      // `persistWaveClose`'s tx and must survive its rollback. The orchestrator
      // TSDoc declares this contract; assert it explicitly so a future refactor
      // that pulls executeTurn into the close tx fails this test loudly.
      const waveMessages = await getMessagesForWave(waveId);
      const userRow = waveMessages.find((m) => m.kind === "user_message");
      const assistantCloseRow = waveMessages.find(
        (m) => m.kind === "assistant_response" && m.turnIndex > 1,
      );
      expect(userRow).toBeDefined();
      expect(assistantCloseRow).toBeDefined();
      // Both rows must land on the same turn — the one `getNextTurnIndex`
      // allocated to executeTurn after the seed questionnaire at turn 1.
      expect(userRow!.turnIndex).toBe(assistantCloseRow!.turnIndex);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. chat_log dual-write: paired with the close-turn assistant_response in
  //    context_messages (Wave N) and the seed assistant_response on Wave N+1
  //    turn-0. The wave UI reads chat_log; this test pins the two-store
  //    invariant for wave-close (mirror of Task 6's scoping → Wave 1 path).
  // ---------------------------------------------------------------------------
  it("dual-writes chat_log: closing entry on Wave N, opening on Wave N+1", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      await seedOpenFreeTextQuestionnaire(courseId, waveId);

      const parsed = makeParsedClose();
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      await executeWaveClose(ctx, "<learner_reply>final</learner_reply>");

      // Closing wave gains the final assistant text entry at the tail of chat_log.
      // `chatLog` is typed `unknown` on the Drizzle row (jsonb isn't parameterised);
      // the row guard validates the shape on read, so the cast here is a typing
      // formality, not a trust-boundary bypass. Mirrors submitBaseline test usage.
      const closingWave = await getWaveByCourseAndNumber(courseId, 2);
      if (!closingWave) throw new Error("closing wave must still exist");
      const closingChatLog = closingWave.chatLog as WaveChatLog;
      expect(closingChatLog.at(-1)).toEqual({
        role: "assistant",
        kind: "text",
        content: parsed.userMessage,
      });

      // Next wave starts with a single assistant opening text entry.
      const nextWave = await getWaveByCourseAndNumber(courseId, 3);
      if (!nextWave) throw new Error("next wave must exist");
      expect(nextWave.chatLog).toEqual([
        {
          role: "assistant",
          kind: "text",
          content: parsed.nextUnitBlueprint.openingText,
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. bug_003: an MC questionnaire posed on the FINAL mid-turn is answered at
  //    close. The model emits a `mc-index` close grading for it. Previously
  //    `applyCloseGradings` hard-threw on `mc-index`, bricking the wave with an
  //    unrecoverable 500. The fix grades it mechanically against the persisted
  //    correct key — correct click → isCorrect=true, XP>0, wave closes.
  // ---------------------------------------------------------------------------
  it("bug_003: grades a correct close-turn mc-index click mechanically and closes the wave", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      const { conceptId, questionId, questionnaireId } = await seedOpenMcQuestionnaire(
        courseId,
        waveId,
        { correct: "B" },
      );

      // Model emits an mc-index grading (what it MUST emit — the close schema's
      // coverage superRefine forces a grading for `q-mc`, and the learner's
      // answer was rendered `kind="mc-index"`).
      const parsed = makeParsedClose({
        gradings: [{ kind: "mc-index", questionId: "q-mc", rationale: "clicked B. teach next." }],
        conceptUpdates: [
          { name: "ownership", qualityScore: 4, reason: "Clicked the right option." },
        ],
      });
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      // Snapshot ctx BEFORE the answer lands — mirrors submitWaveTurn ordering.
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      // Learner clicks the correct option (B). Lands on the live chat_log after
      // the snapshot, exactly as submitWaveTurn does pre-LLM.
      await appendCloseMcAnswer(waveId, questionnaireId, "B");
      // Before the fix this throws (the `mc-index` branch hard-throws); after it
      // resolves and closes the wave.
      const result = await executeWaveClose(ctx, "<learner_reply>final</learner_reply>");

      expect(result.kind).toBe("close-turn");
      expect(result.gradedSignals).toHaveLength(1);
      expect(result.gradedSignals[0]).toMatchObject({ kind: "mc-index", questionId: "q-mc" });
      expect(result.gradedSignals[0]!.xpAwarded).toBeGreaterThan(0);

      // Assessment row graded mechanically: B == correct B → isCorrect=true,
      // qualityScore=4 (MC-correct convention), XP>0.
      const assessmentRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, questionId))
      )[0]!;
      expect(assessmentRow.isCorrect).toBe(true);
      expect(assessmentRow.qualityScore).toBe(4);
      expect(assessmentRow.xpAwarded).toBeGreaterThan(0);
      // The learner's clicked key is persisted onto the row's user_answer.
      expect(assessmentRow.userAnswer).toBe("B");

      // Wave N closed, Wave N+1 opened — the wave is no longer bricked.
      const closedWave = (await db.select().from(waves).where(eq(waves.id, waveId)))[0]!;
      expect(closedWave.status).toBe("closed");
      // Concept SM-2 still advanced from conceptUpdates.
      const afterConcept = (await db.select().from(concepts).where(eq(concepts.id, conceptId)))[0]!;
      expect(afterConcept.lastQualityScore).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. bug_003: a WRONG close-turn MC click. The model's `mc-index` grading is
  //    NOT trusted for correctness — the server computes it from the persisted
  //    correct key. Wrong click → isCorrect=false, 0 XP. The wave still closes.
  // ---------------------------------------------------------------------------
  it("bug_003: grades a wrong close-turn mc-index click as incorrect, zero XP, wave still closes", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      const { questionId, questionnaireId } = await seedOpenMcQuestionnaire(courseId, waveId, {
        correct: "B",
      });

      const parsed = makeParsedClose({
        gradings: [{ kind: "mc-index", questionId: "q-mc", rationale: "clicked D. reteach." }],
        conceptUpdates: [
          { name: "ownership", qualityScore: 1, reason: "Picked the wrong option." },
        ],
      });
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      // Learner clicks D — wrong (correct is B). The model's grading is NOT
      // trusted for correctness; the server computes D != B server-side.
      await appendCloseMcAnswer(waveId, questionnaireId, "D");
      const result = await executeWaveClose(ctx, "<learner_reply>final</learner_reply>");

      expect(result.kind).toBe("close-turn");
      expect(result.gradedSignals[0]).toMatchObject({
        kind: "mc-index",
        questionId: "q-mc",
        xpAwarded: 0,
      });

      // Server-computed correctness: D != correct B → isCorrect=false, q=1, 0 XP.
      const assessmentRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, questionId))
      )[0]!;
      expect(assessmentRow.isCorrect).toBe(false);
      expect(assessmentRow.qualityScore).toBe(1);
      expect(assessmentRow.xpAwarded).toBe(0);
      expect(assessmentRow.userAnswer).toBe("D");

      const closedWave = (await db.select().from(waves).where(eq(waves.id, waveId)))[0]!;
      expect(closedWave.status).toBe("closed");
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Scoring boundary: free-text XP must use the DB concept tier, NOT the
  //    LLM-emitted `g.conceptTier`. Seed a tier-2 concept, but have the close
  //    payload claim `conceptTier: 1`. XP scales linearly with tier
  //    (XP = tier × basePerTier × multiplier), so the only way to award the
  //    tier-2 value is to read the tier from the persisted concept row.
  //    This is the anti-gaming boundary: the LLM never influences XP.
  // ---------------------------------------------------------------------------
  it("free-text XP uses the DB concept tier, not the LLM-emitted conceptTier", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      // Concept is persisted at tier 2 — the authoritative tier for XP.
      const { questionId } = await seedOpenFreeTextQuestionnaire(courseId, waveId, "ownership", 2);

      // The close payload claims tier 1 (still in-scope [1,2], so it passes the
      // wire schema). If the LLM value leaked into scoring, XP would be the
      // tier-1 amount; the DB-derived tier-2 lookup must win.
      const parsed = makeParsedClose({
        gradings: [
          {
            kind: "free-text",
            questionId: "q-close",
            verdict: "correct",
            qualityScore: 5,
            conceptName: "ownership",
            conceptTier: 1, // LLM lies low to suppress XP — must be ignored.
            rationale: "captured it. move on.",
          },
        ],
      });
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const result = await executeWaveClose(ctx, "<learner_reply>final</learner_reply>");

      // Expected XP for the DB tier (2) at qualityScore 5. Computed via the
      // pure scoring function so this stays in lockstep with tuning changes.
      const dbTierXp = calculateXP(2, 5);
      const llmTierXp = calculateXP(1, 5);
      // Sanity: the two tiers must produce DIFFERENT XP, else the test proves
      // nothing. (calculateXP is linear in tier, so this always holds.)
      expect(dbTierXp).not.toBe(llmTierXp);

      // Awarded XP reflects the DB tier (2), NOT the LLM-emitted tier (1).
      expect(result.gradedSignals[0]!.xpAwarded).toBe(dbTierXp);
      const assessmentRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, questionId))
      )[0]!;
      expect(assessmentRow.xpAwarded).toBe(dbTierXp);
    });
  });
});
