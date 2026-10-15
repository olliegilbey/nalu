import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { waitForLockWaiters } from "@/db/testing/waitForLockWaiters";
import { db } from "@/db/client";
import { userProfiles, courses, waves } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { setCourseStartingStateInTx } from "@/db/queries/courses.tx";
import { appendWaveChatLog, openWave } from "@/db/queries/waves.writes";
import { appendMessage } from "@/db/queries/contextMessages.writes";
import { getNextTurnIndex } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts.writes";
import { insertOpenAssessments } from "@/db/queries/assessments.open";
import { WAVE } from "@/lib/config/tuning";
import { calculateMcXp } from "@/lib/scoring/xp";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import { loadWaveContext } from "./loadWaveContext";
import { namespaceQuestionId } from "./namespaceQuestionId";
import { persistWaveMidTurn } from "./persistWaveMidTurn";
import { persistWaveClose } from "./persistWaveClose";

/**
 * Lock order across the two Wave save transactions (PR #212 review).
 *
 * Tab 1 answers a quiz mid-Wave. Tab 2 sends the close turn while tab 1's
 * save is still running (`prepareWaveTurn` lets it: tab 1's answers already
 * closed the quiz). The mid-turn save writes course XP for each graded answer,
 * then the Wave row. The close save writes the Wave row, then course XP.
 * Unless both lock the course row first, Postgres sees a cycle and kills one
 * save with 40P01.
 *
 * The race is forced with a third "blocker" tx. It holds an uncommitted
 * concept that tab 1's new quiz also inserts, so tab 1 pauses mid-save, after
 * its grading and before its Wave write. Tab 2 runs while tab 1 waits.
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

/** The concept tab 1's new quiz names; the blocker inserts it first. */
const PAUSE_CONCEPT = "lifetimes";

/**
 * Seed an active course with open Wave 1 and one open MC quiz (correct key B)
 * with its placeholder assessment row. Returns the ids and the quiz id.
 */
async function seedWaveWithOpenQuiz(): Promise<{
  readonly courseId: string;
  readonly waveId: string;
  readonly questionnaireId: string;
}> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  await setCourseStartingStateInTx(course.id, { summary: "seed", startingTier: 1 }, db);
  const wave = await openWave({
    courseId: course.id,
    waveNumber: 1,
    tier: 1,
    frameworkSnapshot: FRAMEWORK,
    customInstructionsSnapshot: null,
    dueConceptsSnapshot: [],
    seedSource: {
      kind: "scoping_handoff",
      blueprint: { topic: "Ownership", outline: ["x"], openingText: "hi", plannedConcepts: [] },
    },
    turnBudget: WAVE.turnCount,
  });
  const concept = await upsertConcept({ courseId: course.id, name: "ownership", tier: 1 });
  const questions = [
    {
      id: "q-mc",
      type: "multiple_choice" as const,
      prompt: "Which keyword transfers ownership?",
      options: { A: "let", B: "move", C: "ref", D: "copy" },
      correct: "B" as const,
      freetextRubric: "rubric",
      conceptName: "ownership",
      tier: 1,
    },
  ];
  const quizRow = await appendMessage({
    parent: { kind: "wave", id: wave.id },
    turnIndex: 1,
    seq: 0,
    kind: "assistant_response",
    role: "assistant",
    content: JSON.stringify({ userMessage: "Try this:", questionnaire: { questions } }),
  });
  await appendWaveChatLog(db, wave.id, {
    role: "assistant",
    kind: "text_with_questionnaire",
    questionnaireId: quizRow.id,
    content: "Try this:",
    questions,
  });
  await insertOpenAssessments({
    waveId: wave.id,
    turnIndex: 1,
    rows: [
      {
        conceptId: concept.id,
        questionId: namespaceQuestionId(quizRow.id, "q-mc"),
        question: questions[0]!.prompt,
        assessmentKind: "card_mc",
      },
    ],
  });
  return { courseId: course.id, waveId: wave.id, questionnaireId: quizRow.id };
}

/** Tab 1's turn output: grade the MC answer, and pose a new quiz on `PAUSE_CONCEPT`. */
const MID_TURN: WaveMidTurn = {
  userMessage: "Right. Next one:",
  comprehensionSignals: [{ kind: "mc-index", questionId: "q-mc", rationale: "Right. Move on." }],
  questionnaire: {
    questions: [
      {
        id: "q-next",
        type: "free_text",
        prompt: "What does a lifetime bound?",
        freetextRubric: "rubric",
        conceptName: PAUSE_CONCEPT,
        tier: 1,
      },
    ],
  },
};

/** Tab 2's close turn output: no gradings (tab 1's answers closed the quiz). */
const CLOSE_TURN: WaveCloseTurn = {
  userMessage: "Closing chat.",
  summary: "We covered ownership.",
  gradings: [],
  nextUnitBlueprint: {
    topic: "Borrowing",
    outline: ["borrow"],
    openingText: "Welcome to lesson 2.",
    plannedConcepts: [{ name: "ownership", tier: 1, role: "fresh" }],
  },
  conceptUpdates: [],
};

/** Walk an error's cause chain for a Postgres SQLSTATE; Drizzle wraps the driver error. */
function postgresCode(e: unknown): string {
  if (typeof e !== "object" || e === null) return String(e);
  if ("code" in e && typeof e.code === "string") return e.code;
  if ("cause" in e) return postgresCode(e.cause);
  return e instanceof Error ? e.message : "unknown error";
}

/** Settle a save to "ok" or its SQLSTATE, so the test can assert both saves at once. */
function settle(save: Promise<unknown>): Promise<string> {
  return save.then(
    () => "ok",
    (e: unknown) => postgresCode(e),
  );
}

describe("Wave save lock order (integration)", () => {
  it("a mid-turn save and a close save on one course both commit", async () => {
    await withTestDb(async () => {
      const { courseId, waveId, questionnaireId } = await seedWaveWithOpenQuiz();
      // Tab 1 loads the Wave with the quiz open, then (as `prepareWaveTurn`
      // does) appends its answer before the LLM call.
      const midCtx = await loadWaveContext({ userId: USER_ID, courseId, waveId });
      await appendWaveChatLog(db, waveId, {
        role: "user",
        kind: "answers",
        questionnaireId,
        responses: [{ questionId: "q-mc", choice: "B" }],
      });
      // The turn runner's rows for tab 1's turn, before its save runs.
      const parent = { kind: "wave", id: waveId } as const;
      const turnIndex = await getNextTurnIndex(parent);
      await appendMessage({
        parent,
        turnIndex,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "x",
      });
      await appendMessage({
        parent,
        turnIndex,
        seq: 1,
        kind: "assistant_response",
        role: "assistant",
        content: MID_TURN.userMessage,
      });
      // Tab 2 loads the Wave after tab 1's answer landed: no quiz is open.
      const closeCtx = await loadWaveContext({ userId: USER_ID, courseId, waveId });

      // Test-fixture slots: both saves start inside the blocker tx and end after it.
      let midTurnSave: Promise<string> | undefined;
      let closeSave: Promise<string> | undefined;
      await db.transaction(async (blockerTx) => {
        await upsertConcept({ courseId, name: PAUSE_CONCEPT, tier: 1 }, blockerTx);
        // Tab 1 grades its answer, then waits on the blocker's concept.
        midTurnSave = settle(
          persistWaveMidTurn({
            ctx: midCtx,
            parsed: MID_TURN,
            payload: {
              kind: "questionnaire-answers",
              questionnaireId,
              answers: [{ id: "q-mc", kind: "mc", selected: "B" }],
            },
            turnsRemaining: 1,
          }),
        );
        await waitForLockWaiters(1);
        // Tab 2 closes the Wave while tab 1 waits.
        closeSave = settle(
          persistWaveClose({ ctx: closeCtx, parsed: CLOSE_TURN, now: new Date() }),
        );
        await waitForLockWaiters(2);
      });
      // The blocker committed: tab 1 resumes.

      // Neither save is killed as a deadlock victim (40P01).
      expect([await midTurnSave, await closeSave]).toEqual(["ok", "ok"]);
      // Both landed: the graded answer's XP plus the completion XP.
      const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
      expect(course?.totalXp).toBe(calculateMcXp(1, true) + WAVE.completionXp);
      const [wave1] = await db.select().from(waves).where(eq(waves.id, waveId));
      expect(wave1?.status).toBe("closed");
    });
  });
});
