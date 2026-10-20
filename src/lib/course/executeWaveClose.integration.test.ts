import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles, assessments, concepts, waves, courses } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { setCourseStartingStateInTx } from "@/db/queries/courses.tx";
import { openWave, appendWaveChatLog, closeWave } from "@/db/queries/waves.writes";
import { getWaveByCourseAndNumber } from "@/db/queries/waves";
import { appendMessage } from "@/db/queries/contextMessages.writes";
import { getMessagesForWave, getNextTurnIndex } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts.writes";
import { insertOpenAssessments } from "@/db/queries/assessments.open";
import { WAVE } from "@/lib/config/tuning";
import { calculateXP } from "@/lib/scoring/xp";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { V3Question, V3Response } from "@/lib/types/jsonb";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import type { McOptionKey } from "@/lib/types/mcOptionKey";
import { renderTeachingSystem } from "@/lib/prompts/teaching";
import { renderContext } from "@/lib/llm/renderContext";
import { saveCustomInstructions } from "@/lib/learner-profile/customInstructions";
import { buildWaveSeed } from "./buildWaveSeed";
import { loadWaveContext } from "./loadWaveContext";
import { executeWaveClose } from "./executeWaveClose";
import { namespaceQuestionId } from "./namespaceQuestionId";
import type { ExecuteTurnParams, ExecuteTurnResult } from "@/lib/turn/executeTurn";

/**
 * Integration tests for `executeWaveClose`.
 *
 * Real Postgres testcontainer except for the LLM call
 * (`vi.spyOn(executeTurn)`). The mock persists user +
 * assistant rows so context_messages reflects production semantics, then the
 * orchestrator's persistence transaction runs end-to-end.
 *
 * Coverage (plan §12 step 1):
 *   1. Happy path: one free-text grading + one conceptUpdate. Assessment row
 *      updated, concept SM-2 advanced, Wave N closed, Wave N+1 opened from the
 *      blueprint with the openingText as turn-0 message, completion XP and the
 *      graded answer's XP added to `courses.total_xp` (issue #205).
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
 *   9. Course summary (issue #93): the close rewrites `courses.summary`, and
 *      Wave N+1's system prompt renders it in `<progress_summary>`.
 *  10. A close whose `closeWave` closes nothing (another path closed Wave N
 *      first) throws PRECONDITION_FAILED and changes nothing.
 *  11. Issue #214: close-graded answers store the learner's text (free text)
 *      and click (MC) on `user_answer`.
 *  12. Issue #236: the close snapshots the learner's saved custom
 *      instructions onto Wave N+1 and leaves Wave N's snapshot as it was.
 *  13. Issue #236: Wave N+1's prompt renders that snapshot escaped. A later
 *      save leaves Wave N+1's rendered Context byte-identical.
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
  // beyond the FK, but `setCourseStartingStateInTx` keeps the course shape
  // consistent with what the post-scoping state would look like in production.
  await setCourseStartingStateInTx(course.id, { summary: "seed", startingTier: 1 }, db);
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

/** A stored question that names its concept, so the seed can upsert it. */
type SeedQuestion = V3Question & { readonly conceptName: string };

/** The close tests' MC question, `q-mc`, with the given correct key. */
function mcQuestion(correct: McOptionKey, conceptName = "ownership"): SeedQuestion {
  return {
    id: "q-mc",
    type: "multiple_choice",
    prompt: "Which keyword transfers ownership?",
    options: { A: "let", B: "move", C: "ref", D: "copy" },
    correct,
    freetextRubric: "rubric",
    conceptName,
    tier: 1,
  };
}

/** The close tests' free-text question, `q-close`, on its concept and tier. */
function freeTextQuestion(conceptName = "ownership", tier = 1): SeedQuestion {
  return {
    id: "q-close",
    type: "free_text",
    prompt: `Explain ${conceptName} in one sentence`,
    freetextRubric: "rubric",
    conceptName,
    tier,
  };
}

/**
 * Seed an OPEN questionnaire on the wave plus one placeholder assessment row
 * per question. Each question's concept is upserted at the question's tier.
 *
 * Writes BOTH the `context_messages` assistant_response AND the `chat_log`
 * `text_with_questionnaire` entry. `findOpenQuestionnaire` (used by
 * `executeWaveClose` and `applyCloseGradings`) derives the open questionnaire
 * from `chat_log`, and its `questionnaireId` namespaces each stored
 * `question_id` (`namespaceQuestionId`), as `insertNewQuestionnaire` does in
 * production. Does NOT write the learner's answers: those must land AFTER
 * `loadWaveContext` snapshots `ctx.wave.chatLog` (see `appendCloseAnswers`),
 * because in production `prepareWaveTurn` appends them post-snapshot.
 *
 * Returns the `questionnaireId`, and per raw question id its concept id (for
 * SM-2 assertions) and namespaced `question_id` (to query the row back).
 */
async function seedOpenQuestionnaire(
  courseId: string,
  waveId: string,
  questions: readonly SeedQuestion[],
): Promise<{
  readonly questionnaireId: string;
  readonly rows: ReadonlyMap<string, { readonly conceptId: string; readonly questionId: string }>;
}> {
  const userMessage = "Final questions:";
  const assistantRow = await appendMessage({
    parent: { kind: "wave", id: waveId },
    turnIndex: 1,
    seq: 0,
    kind: "assistant_response",
    role: "assistant",
    content: JSON.stringify({ userMessage, questionnaire: { questions } }),
  });
  await appendWaveChatLog(db, waveId, {
    role: "assistant",
    kind: "text_with_questionnaire",
    questionnaireId: assistantRow.id,
    content: userMessage,
    questions: [...questions],
  });
  const seeded = await Promise.all(
    questions.map(async (q) => {
      const concept = await upsertConcept({ courseId, name: q.conceptName, tier: q.tier ?? 1 });
      return { q, conceptId: concept.id, questionId: namespaceQuestionId(assistantRow.id, q.id) };
    }),
  );
  await insertOpenAssessments({
    waveId,
    turnIndex: 1,
    rows: seeded.map((s) => ({
      conceptId: s.conceptId,
      questionId: s.questionId,
      question: s.q.prompt,
      assessmentKind: s.q.type === "multiple_choice" ? "card_mc" : "card_freetext",
    })),
  });
  return {
    questionnaireId: assistantRow.id,
    rows: new Map(
      seeded.map((s) => [s.q.id, { conceptId: s.conceptId, questionId: s.questionId }] as const),
    ),
  };
}

/** Seed an open questionnaire with one free-text question, `q-close`. */
async function seedOpenFreeTextQuestionnaire(
  courseId: string,
  waveId: string,
  conceptName = "ownership",
  conceptTier = 1,
): Promise<{ readonly conceptId: string; readonly questionId: string }> {
  const { rows } = await seedOpenQuestionnaire(courseId, waveId, [
    freeTextQuestion(conceptName, conceptTier),
  ]);
  return rows.get("q-close")!;
}

/**
 * Seed an open questionnaire with one MC question, `q-mc`.
 *
 * bug_003: a questionnaire posed on the FINAL mid-turn has no later mid-turn,
 * so its MC question is answered — and graded — at close. Returns the
 * `questionnaireId` too, so the test can append the matching answer.
 */
async function seedOpenMcQuestionnaire(
  courseId: string,
  waveId: string,
  opts: { readonly correct: McOptionKey; readonly conceptName?: string },
): Promise<{
  readonly conceptId: string;
  readonly questionId: string;
  readonly questionnaireId: string;
}> {
  const { questionnaireId, rows } = await seedOpenQuestionnaire(courseId, waveId, [
    mcQuestion(opts.correct, opts.conceptName),
  ]);
  return { ...rows.get("q-mc")!, questionnaireId };
}

/**
 * Append the learner's close-turn Responses to the LIVE `chat_log`. Production
 * `prepareWaveTurn` does this pre-LLM, AFTER `loadWaveContext` has snapshotted
 * `ctx.wave.chatLog` — so tests must call this between `loadWaveContext` and
 * `executeWaveClose` to faithfully reproduce the bug_003 path: the snapshot
 * still sees the questionnaire as OPEN; `applyCloseGradings` re-reads the live
 * column to find the answers.
 */
async function appendCloseAnswers(
  waveId: string,
  questionnaireId: string,
  responses: readonly V3Response[],
): Promise<void> {
  await appendWaveChatLog(db, waveId, {
    role: "user",
    kind: "answers",
    questionnaireId,
    responses: [...responses],
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

/** A saved preference with characters the render must escape. */
const PREFERENCE = "Use analogies <not lists> & keep it short.";

/**
 * Open Wave 2, save `preference` as the learner would mid-Wave, then run the
 * close turn. Must run inside `withTestDb`. Returns the ids the tests read.
 */
async function closeWaveAfterSaving(preference: string): Promise<{
  readonly courseId: string;
  readonly waveId: string;
  readonly nextWaveId: string;
}> {
  const { courseId, waveId } = await seedCourseWithOpenWave(2);
  await seedOpenFreeTextQuestionnaire(courseId, waveId);
  await saveCustomInstructions(USER_ID, preference);

  const parsed = makeParsedClose();
  vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
    makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
  );
  const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
  const result = await executeWaveClose(ctx, "<learner_reply>final</learner_reply>");
  return { courseId, waveId, nextWaveId: result.nextWaveId };
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
      // Fix 2: orchestrator must surface the new wave's row id so the client
      // can redirect/refresh.
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

      // courses.total_xp gains the completion XP AND the close grading's XP
      // (issue #205). The grading's XP is the tier-1, q5 award on the row.
      expect(assessmentRow.xpAwarded).toBe(calculateXP(1, 5));
      const afterCourse = (await db.select().from(courses).where(eq(courses.id, courseId)))[0]!;
      expect(afterCourse.totalXp).toBe(WAVE.completionXp + assessmentRow.xpAwarded);
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
      // Array+await reduce, not for/let (immutable by default).
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
      // XP not incremented: the grading's XP rolls back; the completion bump never runs.
      const afterCourse = (await db.select().from(courses).where(eq(courses.id, courseId)))[0]!;
      expect(afterCourse.totalXp).toBe(0);
      // The course summary rewrite rolls back too: it keeps the scoping seed.
      expect(afterCourse.summary).toBe("seed");

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

      // Snapshot ctx BEFORE the answer lands — mirrors prepareWaveTurn ordering.
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      // Learner clicks the correct option (B). Lands on the live chat_log after
      // the snapshot, exactly as prepareWaveTurn does pre-LLM.
      await appendCloseAnswers(waveId, questionnaireId, [{ questionId: "q-mc", choice: "B" }]);
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
      // The MC grading's XP reaches courses.total_xp with the completion XP (issue #205).
      const afterCourse = (await db.select().from(courses).where(eq(courses.id, courseId)))[0]!;
      expect(afterCourse.totalXp).toBe(WAVE.completionXp + assessmentRow.xpAwarded);

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
      await appendCloseAnswers(waveId, questionnaireId, [{ questionId: "q-mc", choice: "D" }]);
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

  // ---------------------------------------------------------------------------
  // 9. Course summary (issue #93). The close's summary is the whole course
  //    summary, rewritten. It replaces the scoping seed in `courses.summary`,
  //    and the next Wave's system prompt renders it in `<progress_summary>`.
  //    `waves.summary` keeps the same text as the closed Wave's snapshot.
  // ---------------------------------------------------------------------------
  it("rewrites courses.summary from the close summary and renders it in Wave N+1's <progress_summary>", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      await seedOpenFreeTextQuestionnaire(courseId, waveId);

      const summary = "Learner explains ownership and moves in their own words. Borrowing is next.";
      const parsed = { ...makeParsedClose(), summary };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      const result = await executeWaveClose(ctx, "<learner_reply>final</learner_reply>");

      // The scoping seed is gone; the close's summary replaces it whole.
      const afterCourse = (await db.select().from(courses).where(eq(courses.id, courseId)))[0]!;
      expect(afterCourse.summary).toBe(summary);
      // The closed Wave keeps the same text as its per-Wave snapshot.
      const closedWave = (await db.select().from(waves).where(eq(waves.id, waveId)))[0]!;
      expect(closedWave.summary).toBe(summary);

      // Wave N+1's system prompt, built the way every turn builds it.
      const next = await loadWaveContext({ userId: USER_ID, courseId, waveId: result.nextWaveId });
      const system = renderTeachingSystem(buildWaveSeed(next.course, next.wave));
      expect(system).toContain(`<progress_summary>\n${summary}\n</progress_summary>`);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. A close that closes nothing fails explicitly. Another path closes
  //     Wave N after this turn loaded it, and no Wave N+1 exists, so nothing
  //     later in the tx would throw on its own. `persistWaveClose` throws
  //     PRECONDITION_FAILED, and the tx changes nothing: no summary rewrite,
  //     no grading, no SM-2, no XP, no Wave N+1.
  // ---------------------------------------------------------------------------
  it("throws PRECONDITION_FAILED and changes nothing when closeWave closes no row", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      const { conceptId, questionId } = await seedOpenFreeTextQuestionnaire(courseId, waveId);
      const initialConcept = (
        await db.select().from(concepts).where(eq(concepts.id, conceptId))
      )[0]!;

      const parsed = { ...makeParsedClose(), summary: "late close must not land" };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      // Load while Wave N is open, as `prepareWaveTurn` would.
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      // Another path closes Wave N before this close's tx runs.
      await closeWave(waveId, { summary: "first close", blueprintEmitted: null });
      const error = await executeWaveClose(ctx, "<learner_reply>final</learner_reply>").catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");

      // Course: summary and XP untouched.
      const afterCourse = (await db.select().from(courses).where(eq(courses.id, courseId)))[0]!;
      expect(afterCourse.summary).toBe("seed");
      expect(afterCourse.totalXp).toBe(0);
      // Assessment row still at its placeholder grading.
      const assessmentRow = (
        await db.select().from(assessments).where(eq(assessments.questionId, questionId))
      )[0]!;
      expect(assessmentRow.qualityScore).toBe(0);
      // SM-2 untouched.
      const afterConcept = (await db.select().from(concepts).where(eq(concepts.id, conceptId)))[0]!;
      expect(afterConcept.repetitionCount).toBe(initialConcept.repetitionCount);
      expect(afterConcept.lastQualityScore).toBe(initialConcept.lastQualityScore);
      expect(afterConcept.nextReviewAt).toEqual(initialConcept.nextReviewAt);
      // No Wave N+1; Wave N keeps the first close's summary.
      const allWaves = await db.select().from(waves).where(eq(waves.courseId, courseId));
      expect(allWaves).toHaveLength(1);
      expect(allWaves[0]!.summary).toBe("first close");
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Issue #214: a close-graded answer stores what the learner sent on
  //     `user_answer`, as a mid-turn grading does. The final questionnaire has
  //     one MC and one free-text question, both answered in the close turn's
  //     `answers` entry. The free-text row gets the typed text, not the `""`
  //     placeholder; the MC row still gets the clicked key.
  // ---------------------------------------------------------------------------
  it("stores the learner's close-turn answers on user_answer: typed text and MC click", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave(2);
      const { questionnaireId, rows } = await seedOpenQuestionnaire(courseId, waveId, [
        mcQuestion("B"),
        freeTextQuestion("borrowing"),
      ]);

      const typed = "A borrow lends a value without moving ownership.";
      const parsed = makeParsedClose({
        gradings: [
          { kind: "mc-index", questionId: "q-mc", rationale: "clicked B. teach next." },
          {
            kind: "free-text",
            questionId: "q-close",
            verdict: "correct",
            qualityScore: 5,
            conceptName: "borrowing",
            conceptTier: 1,
            rationale: "captured it. move on.",
          },
        ],
      });
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeExecuteTurnMock(parsed) as unknown as typeof executeTurnModule.executeTurn,
      );

      // Snapshot first, then the answers land, as in `prepareWaveTurn`.
      const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      await appendCloseAnswers(waveId, questionnaireId, [
        { questionId: "q-mc", choice: "B" },
        { questionId: "q-close", freetext: typed },
      ]);
      await executeWaveClose(ctx, "<learner_reply>final</learner_reply>");

      const ftRow = (
        await db
          .select()
          .from(assessments)
          .where(eq(assessments.questionId, rows.get("q-close")!.questionId))
      )[0]!;
      expect(ftRow.qualityScore).toBe(5);
      expect(ftRow.userAnswer).toBe(typed);
      const mcRow = (
        await db
          .select()
          .from(assessments)
          .where(eq(assessments.questionId, rows.get("q-mc")!.questionId))
      )[0]!;
      expect(mcRow.isCorrect).toBe(true);
      expect(mcRow.userAnswer).toBe("B");
    });
  });

  // ---------------------------------------------------------------------------
  // 12. Custom instructions (issue #236). The learner saves a preference
  //     during Wave N. The close snapshots it onto Wave N+1, raw. Wave N's
  //     snapshot, taken when it opened, stays null.
  // ---------------------------------------------------------------------------
  it("snapshots custom instructions saved during Wave N onto Wave N+1, leaving Wave N's unchanged", async () => {
    await withTestDb(async () => {
      const { courseId, waveId, nextWaveId } = await closeWaveAfterSaving(PREFERENCE);

      const nextWave = (await db.select().from(waves).where(eq(waves.id, nextWaveId)))[0]!;
      expect(nextWave.customInstructionsSnapshot).toBe(PREFERENCE);
      const closedWave = await getWaveByCourseAndNumber(courseId, 2);
      expect(closedWave?.id).toBe(waveId);
      expect(closedWave?.customInstructionsSnapshot).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 13. Byte stability (issue #236). Wave N+1's prompt renders its snapshot,
  //     escaped. A save while Wave N+1 is open changes no byte of its
  //     Context: the render reads the snapshot, never the live profile.
  // ---------------------------------------------------------------------------
  it("renders Wave N+1's snapshot escaped, and a later save leaves its Context byte-identical", async () => {
    await withTestDb(async () => {
      const { courseId, nextWaveId } = await closeWaveAfterSaving(PREFERENCE);

      // Build the Context the way every Wave turn builds it.
      const renderOpenWave = async () => {
        const ctx = await loadWaveContext({ userId: USER_ID, courseId, waveId: nextWaveId });
        return renderContext(
          buildWaveSeed(ctx.course, ctx.wave),
          await getMessagesForWave(nextWaveId),
        );
      };

      const before = await renderOpenWave();
      expect(before.system).toContain(
        "<custom_instructions>\nUse analogies &lt;not lists&gt; &amp; keep it short.\n</custom_instructions>",
      );

      await saveCustomInstructions(USER_ID, "Use bullet lists.");

      const after = await renderOpenWave();
      expect(after.system).toBe(before.system);
      expect(after.messages).toEqual(before.messages);
      const openNextWave = await getWaveByCourseAndNumber(courseId, 3);
      expect(openNextWave?.customInstructionsSnapshot).toBe(PREFERENCE);
    });
  });
});
