/**
 * Live smoke test for the scoping CLOSE step: chains the full pipeline
 * (clarify → generateFramework → generateBaseline → submitBaseline) against
 * real Cerebras + testcontainers Postgres. Verifies the close-turn schema,
 * persistence widening, Wave 1 opening, and XP bookkeeping under real model output.
 *
 * WHY one topic (not three): `course.live.test.ts` already covers clarify →
 * framework → baseline across three diverse topics. The close turn is
 * topic-agnostic — running it once adds ~30-60s to `just smoke` instead of
 * tripling the runtime.
 *
 * Gated behind `CEREBRAS_LIVE=1 && LLM_API_KEY`; never runs in CI or
 * `just check`. Per-turn observability (label "scoping-close") is emitted by
 * `executeTurn` automatically.
 */

import { describe, test, expect, beforeAll } from "vitest";
import { eq, desc, and } from "drizzle-orm";
import { withTestDb } from "@/db/testing/withTestDb";
import { appRouter } from "./index";
import { userProfiles, courses, contextMessages, waves } from "@/db/schema";
import { SCOPING_TOPICS } from "@/lib/testing/topicPool";
import {
  assertFrameworkStructural,
  assertBaselineStructural,
} from "@/lib/testing/scopingInvariants";
import { baselineClosedJsonbSchema, type FrameworkJsonb } from "@/lib/types/jsonb";
import type { BaselineAnswer } from "@/lib/course/submitBaseline";
import { __resetEnvCacheForTests } from "@/lib/config";
import { emitSmokeFinalSnapshot } from "@/lib/testing/smokeFinalSnapshot";

// Gate: skip every test unless both flags are set. Mirrors course.live.test.ts.
const LIVE = process.env.CEREBRAS_LIVE === "1" && Boolean(process.env.LLM_API_KEY);

// Fixed test-user UUID — same pattern as other live tests.
const LIVE_TEST_USER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Single topic — the close-turn code path is topic-agnostic.
const TOPIC = SCOPING_TOPICS[0]!;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Log provider/model so live output is self-documenting (matches neighbour).
beforeAll(() => {
  if (!LIVE) return;
  console.log("[live] provider base URL:", process.env.LLM_BASE_URL ?? "(default)");
  console.log("[live] model:", process.env.LLM_MODEL ?? "(default)");
});

describe.skipIf(!LIVE)("scoping CLOSE flow — live Cerebras", () => {
  test(`${TOPIC.slug}: clarify → framework → baseline → submitBaseline`, async () => {
    await withTestDb(async (db) => {
      // Seed a test user — withTestDb truncates tables before each call.
      await db
        .insert(userProfiles)
        .values({ id: LIVE_TEST_USER, displayName: "Live Test User (close)" });

      const caller = appRouter.createCaller({ userId: LIVE_TEST_USER });

      // 1. clarify
      const clarifyResult = await caller.course.clarify({ topic: TOPIC.topic });
      const { courseId } = clarifyResult;
      const clarifyingQuestions = clarifyResult.clarification.questions.questions;
      expect(clarifyingQuestions.length, "clarify: ≥ 2 questions").toBeGreaterThanOrEqual(2);

      // 2. generateFramework — cycle the answer pool to fill however many
      //    clarifying questions the model returned (2–4).
      const responses = clarifyingQuestions.map((q, i) => ({
        questionId: q.id,
        freetext: TOPIC.answerPool[i % TOPIC.answerPool.length]!,
      }));
      const { framework } = await caller.course.generateFramework({ courseId, responses });
      assertFrameworkStructural(framework);

      // 3. generateBaseline
      const { baseline } = await caller.course.generateBaseline({ courseId });
      assertBaselineStructural(baseline, framework);

      // 4. submitBaseline — build one BaselineAnswer per question.
      //    MC: pick "A" (grading is mechanical; correctness doesn't affect the
      //    assertion surface — we just need coverage of every qid).
      //    free_text: a plausible learner answer from the topic pool.
      const questions = baseline.questions.questions as ReadonlyArray<{
        readonly id: string;
        readonly type: "multiple_choice" | "free_text";
      }>;
      // Mutable array matches the router's `z.array(...)` element type; entries
      // are still per-entry-immutable via `as const`.
      const answers: BaselineAnswer[] = questions.map((q) =>
        q.type === "multiple_choice"
          ? ({ id: q.id, kind: "mc", selected: "A" } as const)
          : ({
              id: q.id,
              kind: "freetext",
              text: TOPIC.answerPool[0]!,
              fromEscape: false,
            } as const),
      );

      // HACK: llama3.1-8b's 8192-token ceiling fits clarify→framework→baseline
      // turns but overflows on close-scoping after they're all appended. Swap
      // to qwen (much larger context) for just the close call. Confined to
      // this smoke; production deploys a single model per env. Remove once the
      // floor model has enough context, or once llama3.1-8b deprecates
      // (2026-05-27) and we pick a wider-context successor.
      //
      // getEnv() caches on first access, so mutating process.env alone is not
      // enough — we must invalidate the cache before and after the swap so
      // the close call sees qwen and subsequent prior-state reads (none here,
      // but defensive) see llama again.
      const originalModel = process.env.LLM_MODEL;
      process.env.LLM_MODEL = "qwen-3-235b-a22b-instruct-2507";
      __resetEnvCacheForTests();
      let result;
      try {
        result = await caller.course.submitBaseline({ courseId, answers });
      } finally {
        process.env.LLM_MODEL = originalModel;
        __resetEnvCacheForTests();
      }

      // Live-return-shape assertions.
      expect(result.userMessage.length, "userMessage non-empty").toBeGreaterThan(0);
      expect(result.wave1Id, "wave1Id is UUID-shaped").toMatch(UUID_RE);

      // 5. Persistence — read state back through withTestDb's `db` handle.
      //    Ad-hoc selects (not new query helpers) match the integration-test convention.
      const courseRow = (await db.select().from(courses).where(eq(courses.id, courseId)))[0];
      expect(courseRow, "course row exists").toBeDefined();
      expect(courseRow!.status, "status flipped to active").toBe("active");
      expect(courseRow!.totalXp, "totalXp > 0").toBeGreaterThan(0);

      // Re-parse via the close-shape schema — asserts all four required
      // close-turn fields are present and well-shaped in one pass.
      const closedBaseline = baselineClosedJsonbSchema.parse(courseRow!.baseline);
      expect(closedBaseline.immutableSummary.length, "immutableSummary non-empty").toBeGreaterThan(
        0,
      );
      expect(closedBaseline.summarySeed.length, "summarySeed non-empty").toBeGreaterThan(0);
      expect(typeof closedBaseline.startingTier, "startingTier is number").toBe("number");

      // startingTier ∈ framework.baselineScopeTiers — defence-in-depth; the
      // close-turn schema already enforces this on parse.
      const scopeTiers = (framework as FrameworkJsonb).baselineScopeTiers;
      expect(scopeTiers, "startingTier ∈ baselineScopeTiers").toContain(
        closedBaseline.startingTier,
      );

      // Coverage: every baseline question must be graded.
      expect(closedBaseline.gradings.length, "gradings cover every question").toBe(
        questions.length,
      );
      const gradedIds = new Set(closedBaseline.gradings.map((g) => g.questionId));
      for (const q of questions) {
        expect(gradedIds, `grading exists for ${q.id}`).toContain(q.id);
      }

      // Wave 1 must be open and tagged at startingTier.
      const wave1 = (await db.select().from(waves).where(eq(waves.id, result.wave1Id)))[0];
      expect(wave1, "Wave 1 row exists").toBeDefined();
      expect(wave1!.status, "Wave 1 is open").toBe("open");
      expect(wave1!.waveNumber, "Wave 1 wave_number=1").toBe(1);
      expect(wave1!.tier, "Wave 1 tier === startingTier").toBe(closedBaseline.startingTier);

      // Latest assistant message on Wave 1 = the openingText seeded by
      // persistScopingClose. Filter by wave+role and order desc so future
      // additional messages don't make this brittle.
      const lastAssistantOnWave1 = (
        await db
          .select()
          .from(contextMessages)
          .where(
            and(eq(contextMessages.waveId, result.wave1Id), eq(contextMessages.role, "assistant")),
          )
          .orderBy(desc(contextMessages.createdAt))
          .limit(1)
      )[0];
      expect(lastAssistantOnWave1, "Wave 1 has an assistant opening message").toBeDefined();
      expect(lastAssistantOnWave1!.content.length, "opening message non-empty").toBeGreaterThan(0);

      // End-of-test forensics: dump the full successful scoping conversation
      // to stderr so a reader can read the final prompt without sifting
      // through any retry diagnoses above. Colour-coded by role via the
      // existing formatPromptBlock; retry counts per step on the banner.
      await emitSmokeFinalSnapshot({ db, courseId, topic: TOPIC.topic });
    });
  });
});
