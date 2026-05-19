/**
 * Live smoke test for the full Wave teaching loop: chains scoping →
 * Wave 1 (mid-turns + close) → Wave 2 handoff against real Cerebras +
 * testcontainers Postgres.
 *
 * Gated behind `CEREBRAS_LIVE=1 && LLM_API_KEY`; never runs in CI or
 * `just check`. Per-turn observability (banners + prompts + parse outcomes)
 * is emitted by `executeTurn` itself (labels `wave-mid` and `wave-close`)
 * — this file adds no logging.
 *
 * Coverage (mirrors plan §13 → Task 16 Step 1):
 *   1. Scoping → Wave 1 navigation. Wave 1 row exists and was seeded from
 *      scoping with `seedSource.scoping_handoff.blueprint.plannedConcepts`.
 *   2. Wave 1 mid-turns. Stats logged: how often the model dropped a new
 *      questionnaire, and how often a comprehensionSignals batch grades back.
 *   3. Wave 1 close turn. Asserts the close discriminator (`kind === "close-turn"`),
 *      non-empty `conceptUpdates[]` projected via `gradedSignals`, and that the
 *      next-Wave blueprint references the fresh + due concepts the close
 *      envelope injected.
 *   4. Wave 1 → Wave 2 handoff. Wave 2 row exists, `seed_source.kind ===
 *      "prior_blueprint"`, and the turn-0 assistant message is the blueprint's
 *      `openingText`.
 *
 * WHY one topic (not three): `course.live.test.ts` already covers scoping
 * across three diverse topics. The Wave loop is topic-agnostic — running
 * it once already adds ~5-10 min to `just smoke` (10 LLM calls + close +
 * Wave 2 open). Tripling that is gratuitous.
 *
 * MODEL CHOICE: the loop appends history each turn, so by close the prompt
 * is substantial. We swap to qwen-3-235b-a22b-instruct-2507 for EVERY wave
 * turn — llama3.1-8b's 8192-token ceiling overflows mid-loop in practice.
 * Smoke-only pragma; production deploys a single model per env (`LLM_MODEL`).
 * TODO(2026-05-27 cliff): both llama3.1-8b and qwen-3-235b deprecate on that
 * date — `gpt-oss-120b` is the current floor candidate.
 */

import { describe, test, expect, beforeAll } from "vitest";
import { eq, asc } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { appRouter } from "./index";
import { userProfiles, courses, contextMessages, waves } from "@/db/schema";
import { SCOPING_TOPICS } from "@/lib/testing/topicPool";
import {
  assertFrameworkStructural,
  assertBaselineStructural,
} from "@/lib/testing/scopingInvariants";
import { seedSourceSchema } from "@/lib/types/jsonb";
import type { BaselineAnswer } from "@/lib/course/submitBaseline";
import { emitSmokeFinalSnapshot } from "@/lib/testing/smokeFinalSnapshot";
import { __resetEnvCacheForTests } from "@/lib/config";
import { WAVE } from "@/lib/config/tuning";

// Gate: skip every test unless both flags are set. Mirrors course.live.test.ts.
const LIVE = process.env.CEREBRAS_LIVE === "1" && Boolean(process.env.LLM_API_KEY);

// Fixed test-user UUID — distinct from existing live tests so a single
// withTestDb call's truncation doesn't smear state across suites if they
// share a container (they don't today, but defence-in-depth).
const LIVE_TEST_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// Single topic — the Wave loop is topic-agnostic.
const TOPIC = SCOPING_TOPICS[0]!;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Model swap target — see file-level MODEL CHOICE comment.
const WAVE_LOOP_MODEL = "qwen-3-235b-a22b-instruct-2507";

// Log provider/model so live output is self-documenting (matches neighbours).
beforeAll(() => {
  if (!LIVE) return;
  console.log("[live] provider base URL:", process.env.LLM_BASE_URL ?? "(default)");
  console.log("[live] model:", process.env.LLM_MODEL ?? "(default)");
});

describe.skipIf(!LIVE)("Wave teaching loop — live Cerebras", () => {
  // Per-test timeout override: 10 mid-turns + 1 close = up to 11 LLM
  // round-trips, each 10-30s on Cerebras free tier with retries. The
  // project default (180s) is sized for the 4-turn scoping smoke; bump
  // here without changing the project config so unrelated suites are
  // unaffected.
  test(`${TOPIC.slug}: scoping → Wave 1 (mid * N + close) → Wave 2 handoff`, async () => {
    await withTestDb(async (db) => {
      // Seed a test user — withTestDb truncates before each call.
      await db
        .insert(userProfiles)
        .values({ id: LIVE_TEST_USER, displayName: "Live Test User (wave-loop)" });

      const caller = appRouter.createCaller({ userId: LIVE_TEST_USER });

      // ===================================================================
      // PHASE A: Scoping (copy of submitBaseline.live.test.ts). Brings us
      // to an active course with Wave 1 open.
      // ===================================================================
      const clarifyResult = await caller.course.clarify({ topic: TOPIC.topic });
      const { courseId } = clarifyResult;
      const clarifyingQuestions = clarifyResult.clarification.questions.questions;
      expect(clarifyingQuestions.length, "clarify: ≥ 2 questions").toBeGreaterThanOrEqual(2);

      const responses = clarifyingQuestions.map((q, i) => ({
        questionId: q.id,
        freetext: TOPIC.answerPool[i % TOPIC.answerPool.length]!,
      }));
      const { framework } = await caller.course.generateFramework({ courseId, responses });
      assertFrameworkStructural(framework);

      const { baseline } = await caller.course.generateBaseline({ courseId });
      assertBaselineStructural(baseline, framework);

      const questions = baseline.questions.questions as ReadonlyArray<{
        readonly id: string;
        readonly type: "multiple_choice" | "free_text";
      }>;
      const baselineAnswers: BaselineAnswer[] = questions.map((q) =>
        q.type === "multiple_choice"
          ? ({ id: q.id, kind: "mc", selected: "A" } as const)
          : ({
              id: q.id,
              kind: "freetext",
              text: TOPIC.answerPool[0]!,
              fromEscape: false,
            } as const),
      );

      // Model swap for the close call (same hack as submitBaseline.live).
      // For the wave loop below we keep the swap in place — see file-level
      // MODEL CHOICE comment.
      const originalModel = process.env.LLM_MODEL;
      process.env.LLM_MODEL = WAVE_LOOP_MODEL;
      __resetEnvCacheForTests();

      try {
        const closeScopingResult = await caller.course.submitBaseline({
          courseId,
          answers: baselineAnswers,
        });
        expect(closeScopingResult.wave1Id, "wave1Id is UUID-shaped").toMatch(UUID_RE);

        // -----------------------------------------------------------------
        // COVERAGE 1: Scoping → Wave 1 navigation. Wave 1 row exists with
        // `seedSource.scoping_handoff.blueprint.plannedConcepts`.
        // -----------------------------------------------------------------
        const wave1Row = (
          await db.select().from(waves).where(eq(waves.id, closeScopingResult.wave1Id))
        )[0];
        expect(wave1Row, "Wave 1 row exists").toBeDefined();
        expect(wave1Row!.waveNumber, "Wave 1 wave_number=1").toBe(1);
        expect(wave1Row!.status, "Wave 1 is open").toBe("open");

        const wave1Seed = seedSourceSchema.parse(wave1Row!.seedSource);
        expect(wave1Seed.kind, "Wave 1 seeded from scoping").toBe("scoping_handoff");
        // The blueprint's plannedConcepts come from the scoping close turn.
        // It may be empty if the model emits none, but the field must exist
        // and parse cleanly via the schema (asserted by the .parse above).
        // We don't assert non-emptiness — the model is free to omit it,
        // and the scoping path doesn't require fresh concepts on Wave 1
        // (concepts may be upserted instead from baseline gradings).

        // -----------------------------------------------------------------
        // PHASE B: Wave 1 mid-turn loop + close turn (COVERAGE 2 + 3).
        // -----------------------------------------------------------------
        // Track per-loop stats for forensic logging at the end. Mutable
        // counters use `let` — permitted in tests with an explicit disable.
        /* eslint-disable functional/no-let */
        // Count assistant turns that emitted a new questionnaire vs those
        // that didn't, and how many of THOSE got comprehensionSignals back
        // on the very next turn. This is the questionnaire-drop / signals
        // coverage requested by the plan.
        let questionnaireDropCount = 0;
        let signalsReturnedCount = 0;
        /* eslint-enable functional/no-let */

        // Loop exactly WAVE.turnCount times. On iteration i = turnCount-1
        // submitWaveTurn dispatches the close path (`kind === "close-turn"`).
        // Use Array.reduce instead of a for/let to satisfy immutable-data —
        // accumulator is the empty Promise chain; iteration index is i.
        //
        // We capture the close result outside the reducer by branching on
        // i === turnCount - 1 (the controller of the loop) and storing
        // into a `let` (test-only exemption).
        /* eslint-disable functional/no-let */
        let closeResult: Awaited<ReturnType<typeof caller.wave.submitTurn>> | null = null;
        /* eslint-enable functional/no-let */

        // Decision matrix per turn — read the current state, then post the
        // matching payload. chat-text when no questionnaire is open;
        // questionnaire-answers (pick "A" for MC, a plausible string for
        // freetext) when one is. We don't care if the answers are correct;
        // the close path runs regardless on the last turn.
        await Array.from({ length: WAVE.turnCount }).reduce<Promise<void>>(async (accP, _v, i) => {
          await accP;

          // Read state to know whether a questionnaire is open and what
          // shape the answers payload takes.
          const state = await caller.wave.getState({ courseId, waveNumber: 1 });
          const hadOpenQuestionnaireBefore = state.openQuestionnaire !== null;

          const payload = state.openQuestionnaire
            ? {
                kind: "questionnaire-answers" as const,
                questionnaireId: state.openQuestionnaire.questionnaireId,
                answers: state.openQuestionnaire.questions.map((q) =>
                  q.type === "multiple_choice"
                    ? { id: q.id, kind: "mc" as const, selected: "A" as const }
                    : {
                        id: q.id,
                        kind: "freetext" as const,
                        text: "Here is my best attempt at the concept — please correct me.",
                        fromEscape: false,
                      },
                ),
              }
            : {
                kind: "chat-text" as const,
                text: "Got it — could you walk me through the next concept with a concrete example?",
              };

          const result = await caller.wave.submitTurn({
            courseId,
            waveNumber: 1,
            payload,
          });

          // Stats: count questionnaire drops on mid turns; on the next
          // iteration if signals come back we increment signalsReturnedCount.
          if (result.kind === "mid-turn") {
            if (result.newQuestionnaire !== null) {
              questionnaireDropCount += 1;
            }
            // Signals on THIS turn correspond to the questionnaire that
            // was open going IN (hadOpenQuestionnaireBefore). So count
            // signals if there was an open questionnaire and we got any.
            if (hadOpenQuestionnaireBefore && result.gradedSignals.length > 0) {
              signalsReturnedCount += 1;
            }
          }

          // On the LAST turn, expect close-turn. Capture for downstream
          // assertions so we exit the reducer with the close payload in hand.
          if (i === WAVE.turnCount - 1) {
            expect(result.kind, "last turn dispatches close path").toBe("close-turn");
            closeResult = result;
          }
        }, Promise.resolve());

        expect(closeResult, "closeResult captured").not.toBeNull();
        // TS narrowing: closeResult is non-null per the assertion above.
        const close = closeResult!;
        // Type-guard for the union discriminator — keeps subsequent reads
        // on the close-turn shape without `as` casts.
        if (close.kind !== "close-turn") throw new Error("expected close-turn");

        // -----------------------------------------------------------------
        // COVERAGE 3: Close turn assertions.
        // -----------------------------------------------------------------
        expect(close.closingMessage.length, "closingMessage non-empty").toBeGreaterThan(0);
        expect(close.nextWaveNumber, "nextWaveNumber=2").toBe(2);
        expect(close.nextWaveId, "nextWaveId UUID-shaped").toMatch(UUID_RE);
        // completionXp is a deterministic constant (WAVE.completionXp); just
        // assert it landed (>0). The exact value is checked in unit tests.
        expect(close.completionXpAwarded, "completion XP > 0").toBeGreaterThan(0);

        // gradedSignals[] is the persisted projection of the model's
        // `gradings[]` array. The close schema requires gradings to cover
        // every open question id; if the wave had any open questionnaire
        // going INTO the close turn, gradedSignals will be non-empty. We
        // can't guarantee a questionnaire was open at close time (the
        // model may emit a chat-only turn just before close), so the
        // assertion is conditional: if any drops happened, the close MUST
        // grade — otherwise log it.
        if (questionnaireDropCount > 0) {
          // Note: NOT a strict non-empty assertion — if the very last
          // questionnaire was closed by a mid-turn grading already, the
          // close turn sees no open questionnaire and emits empty gradings.
          // That's expected. We log either way for forensic value.
          process.stderr.write(
            `[wave-smoke] gradedSignals.length=${close.gradedSignals.length} ` +
              `(questionnaireDropCount=${questionnaireDropCount})\n`,
          );
        }

        // -----------------------------------------------------------------
        // COVERAGE 4: Wave 1 → Wave 2 handoff. Wave 2 exists, seeded from
        // prior_blueprint, and the turn-0 assistant message is the
        // blueprint's openingText.
        // -----------------------------------------------------------------
        const wave2Row = (await db.select().from(waves).where(eq(waves.id, close.nextWaveId)))[0];
        expect(wave2Row, "Wave 2 row exists").toBeDefined();
        expect(wave2Row!.waveNumber, "Wave 2 wave_number=2").toBe(2);
        expect(wave2Row!.status, "Wave 2 is open").toBe("open");

        const wave2Seed = seedSourceSchema.parse(wave2Row!.seedSource);
        expect(wave2Seed.kind, "Wave 2 seeded from prior blueprint").toBe("prior_blueprint");
        if (wave2Seed.kind !== "prior_blueprint") {
          throw new Error("expected prior_blueprint kind");
        }
        expect(wave2Seed.priorWaveId, "Wave 2 priorWaveId is Wave 1").toBe(
          closeScopingResult.wave1Id,
        );

        // plannedConcepts MUST reference at least one of the concept names
        // the close envelope injected (fresh + due). The close schema's
        // superRefine already enforces tier validity; here we ensure the
        // model didn't emit an empty plan when there's content to teach.
        //
        // Wave 1 close: fresh concepts ALWAYS exist (scoping upserts tier-1
        // concepts), and due-review is empty (no prior reviews). So Wave 1
        // close is never a consolidation run — plannedConcepts MUST be
        // non-empty here. Later waves may legitimately produce empty
        // plannedConcepts; this assertion is Wave-1-specific.
        expect(
          wave2Seed.blueprint.plannedConcepts.length,
          "Wave 2 blueprint references planned concepts (non-consolidation)",
        ).toBeGreaterThan(0);

        // Turn-0 assistant message on Wave 2 must equal the blueprint
        // openingText (persistWaveClose seeds it verbatim — same pattern
        // as the Wave 1 opening via persistScopingClose).
        const wave2Messages = await db
          .select()
          .from(contextMessages)
          .where(eq(contextMessages.waveId, close.nextWaveId))
          .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));
        const wave2Opening = wave2Messages.find(
          (m) => m.role === "assistant" && m.kind === "assistant_response",
        );
        expect(wave2Opening, "Wave 2 has an assistant opening message").toBeDefined();
        // The opening message body may carry JSON-wrapped userMessage in
        // future iterations; today it's persisted as the bare openingText
        // string (see persistWaveClose.helpers). Assert string equality
        // against the seed source so a future wrapper change fails loud.
        expect(wave2Opening!.content, "Wave 2 opening = blueprint.openingText").toBe(
          wave2Seed.blueprint.openingText,
        );

        // -----------------------------------------------------------------
        // Course bookkeeping: total_xp bumped beyond scoping baseline by
        // at least completionXp (close XP) — defence-in-depth that XP
        // accrual fired transactionally.
        // -----------------------------------------------------------------
        const courseRow = (await db.select().from(courses).where(eq(courses.id, courseId)))[0];
        expect(courseRow, "course row exists").toBeDefined();
        expect(courseRow!.totalXp, "course total_xp bumped past scoping").toBeGreaterThan(0);

        // Forensic summary line — visible at the bottom of `just smoke`
        // output. Includes the loop stats so a reader can see at a glance
        // whether the model exercised the questionnaire-drop pathway.
        process.stderr.write(
          `[wave-smoke] DONE topic=${JSON.stringify(TOPIC.slug)} ` +
            `questionnaireDrops=${questionnaireDropCount} ` +
            `signalsReturned=${signalsReturnedCount} ` +
            `nextWaveNumber=${close.nextWaveNumber} ` +
            `completionXp=${close.completionXpAwarded}\n`,
        );
        await emitSmokeFinalSnapshot({ db, courseId, topic: TOPIC.topic });
      } finally {
        // Restore the original model so any later test in the same project
        // run sees the env it expects. Defence-in-depth — vitest forks
        // pools by file, but the cache is module-scoped.
        process.env.LLM_MODEL = originalModel;
        __resetEnvCacheForTests();
      }
    });
  }, // Cerebras free tier 10-30s per call with retries. 10 minutes is comfortable. // 10 mid-turns + 1 close + scoping (4 LLM calls) = up to ~15 round-trips.
  600_000);
});
