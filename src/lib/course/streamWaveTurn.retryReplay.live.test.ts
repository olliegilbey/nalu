/**
 * Forced-retry live proof for issue #140: after a failed tool-turn attempt,
 * does the retry pass the real gate?
 *
 * WHY forced: a real first-attempt failure is rare model variance. Two
 * cases force one, then let attempt 1 meet the real gate:
 * - forced-gate: the gate is wrapped so attempt 0 fails ONCE with the real
 *   JSON-leak directive, whatever the model wrote.
 * - scripted-leak: attempt 0 is scripted as the live-observed leak (prose,
 *   then a quiz dumped as JSON text), so the real gate rejects it.
 * The replayed failed attempt is what #140 is about: it must read as the
 * prose the learner saw, never as a JSON object that primes the model to
 * answer in JSON again.
 *
 * Each case logs one `[forced-retry]` line, so a loop of runs can count
 * attempt-1 failures before and after a change.
 *
 * Gated behind `CEREBRAS_LIVE=1 && LLM_API_KEY`; never runs in CI/`just check`.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import type { UIMessageStreamWriter } from "ai";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse } from "@/db/queries/courses";
import { setCourseStartingState } from "@/db/queries/courses.scoping";
import { openWave } from "@/db/queries/waves.writes";
import { userIdStore } from "@/lib/llm/userIdStore";
import { WAVE } from "@/lib/config/tuning";
import * as waveMidTurnAgentModule from "@/lib/agents/waveMidTurnAgent";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";
import type { SubmitTurnPayload } from "./buildLearnerInput";
import * as gateModule from "./waveMidTurnGate";
import { streamWaveTurn } from "./streamWaveTurn";

const LIVE = process.env.CEREBRAS_LIVE === "1" && Boolean(process.env.LLM_API_KEY);

// Distinct from other live suites' users (defence-in-depth vs truncation smear).
const LIVE_TEST_USER = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

/** Minimal framework snapshot for the seeded Wave. */
const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["ownership"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["borrowing"] },
  ],
} as const;

/** Asks for a quiz, so a real attempt usually calls presentQuestionnaire. */
const PAYLOAD: SubmitTurnPayload = {
  kind: "chat-text",
  text: "Teach me one small idea, then quiz me with one multiple-choice question.",
};

/** Attempt 0's scripted reply: a safe lead-in, then a leaked quiz with its answer key. */
const LEAKED_PROSE =
  "Ownership means each value has exactly one owner. Let's check that.\n" +
  JSON.stringify({
    questions: [
      {
        id: "q1",
        type: "multiple_choice",
        prompt: "After `let b = a;` with a String, who owns the data?",
        options: { A: "a", B: "b", C: "both", D: "neither" },
        correct: "B",
        conceptName: "ownership",
        tier: 1,
      },
    ],
  });

/** Seed user + course + open Wave 1 (no scoping LLM calls). */
async function seedOpenWave(): Promise<{ readonly courseId: string }> {
  await db
    .insert(userProfiles)
    .values({ id: LIVE_TEST_USER, displayName: "Live Test User (retry replay)" });
  const course = await createCourse({ userId: LIVE_TEST_USER, topic: "Rust ownership" });
  await setCourseStartingState(course.id, {
    initialSummary: "Learner knows basic syntax; start at ownership fundamentals.",
    startingTier: 1,
    currentTier: 1,
  });
  await openWave({
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
        outline: ["moves", "drops"],
        openingText: "Welcome! Let's learn ownership.",
        plannedConcepts: [{ name: "ownership", tier: 1, role: "fresh" as const }],
      },
    },
    turnBudget: WAVE.turnCount,
  });
  return { courseId: course.id };
}

/** A writer that drops every part: these tests assert on gate verdicts. */
const silentWriter = {
  write: () => undefined,
  merge: () => undefined,
  onError: undefined,
} as unknown as UIMessageStreamWriter<WaveTurnUIMessage>;

/** Usage for a scripted attempt: it makes no provider call. */
const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/**
 * Spy on the gate. Every call runs the REAL gate and records its verdict.
 * With `forceFirst`, attempt 0 returns that failure instead of its verdict.
 */
function recordGateVerdicts(
  forceFirst: ValidationGateFailure | null,
): readonly (ValidationGateFailure | null)[] {
  // Capture the real gate BEFORE spying: the namespace binding is live.
  const realGate = gateModule.validateWaveMidToolTurn;
  const verdicts: (ValidationGateFailure | null)[] = [];
  vi.spyOn(gateModule, "validateWaveMidToolTurn").mockImplementation(
    (collector, prose, payload) => {
      const verdict = realGate(collector, prose, payload);
      verdicts.push(verdict);
      return verdicts.length === 1 && forceFirst !== null ? forceFirst : verdict;
    },
  );
  return verdicts;
}

/**
 * Script attempt 0 as one text Step holding `prose`; later attempts run the
 * real agent. The REAL builder still runs, so the collector is real.
 */
function scriptFirstAttempt(prose: string): void {
  const realBuild = waveMidTurnAgentModule.buildWaveMidTurnAgent;
  const built = { count: 0 };
  vi.spyOn(waveMidTurnAgentModule, "buildWaveMidTurnAgent").mockImplementation((params) => {
    const instance = realBuild(params);
    built.count += 1;
    if (built.count > 1) return instance;
    const stream = () =>
      Promise.resolve({
        fullStream: (async function* () {
          if (prose.length > 0) yield { type: "text-delta", id: "t0", text: prose };
        })(),
        steps: Promise.resolve([{ text: prose, toolCalls: [], toolResults: [], content: [] }]),
        totalUsage: Promise.resolve(NO_USAGE),
      });
    return { ...instance, agent: { stream } as never };
  });
}

/** Run one mid-turn as the route does. Resolves to the error it threw, or null. */
function runTurn(courseId: string): Promise<unknown> {
  // ALS wrap mirrors the streaming route (rate-limiter lane resolution).
  return userIdStore
    .run(LIVE_TEST_USER, () =>
      streamWaveTurn(
        { userId: LIVE_TEST_USER, courseId, waveNumber: 1, payload: PAYLOAD },
        silentWriter,
      ),
    )
    .then(
      () => null,
      (e: unknown) => e,
    );
}

/** Log the countable `[forced-retry]` line, then assert attempt 1 passed. */
function expectAttemptOnePassed(
  label: string,
  verdicts: readonly (ValidationGateFailure | null)[],
  error: unknown,
): void {
  const attempt1 = verdicts[1];
  const outcome = attempt1 === undefined ? "none" : attempt1 === null ? "pass" : "fail";
  process.stderr.write(
    `[forced-retry] case=${label} attempt1=${outcome} attempts=${verdicts.length} ` +
      `landed=${error === null}` +
      (attempt1 ? ` reason="${attempt1.detail.slice(0, 60)}"` : "") +
      "\n",
  );
  // A transport error is not a gate outcome: surface it as-is.
  if (error !== null && !(error instanceof ValidationGateFailure)) throw error;
  expect(attempt1, "attempt 1 passes the real gate").toBeNull();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!LIVE)("streamWaveTurn retry replay — live Cerebras (#140)", () => {
  test("after a forced JSON-leak failure, attempt 1 passes the real gate", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedOpenWave();
      // The real JSON-leak directive, so the test never copies its bytes.
      const forced = gateModule.validateWaveMidToolTurn(
        { questionnaire: null, signals: [] },
        '{"questions": []}',
        PAYLOAD,
      );
      expect(forced?.detail, "real JSON-leak directive").toContain("raw JSON object");
      const verdicts = recordGateVerdicts(forced);

      const error = await runTurn(courseId);

      expectAttemptOnePassed("forced-gate", verdicts, error);
    });
  }, 300_000); // two tool loops, each up to LLM.maxToolSteps provider calls

  test("after a real JSON leak on attempt 0, attempt 1 passes the real gate", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedOpenWave();
      scriptFirstAttempt(LEAKED_PROSE);
      const verdicts = recordGateVerdicts(null);

      const error = await runTurn(courseId);

      expect(verdicts[0]?.detail, "attempt 0 fails as a JSON leak").toContain("raw JSON object");
      expectAttemptOnePassed("scripted-leak", verdicts, error);
    });
  }, 300_000);
});
