/**
 * Live smoke tests for the scoping flow (clarify → generateFramework → generateBaseline).
 *
 * WHY this file: the integration tests mock `generateChat`. This file exercises
 * the exact same router procedures against real Cerebras + a testcontainers
 * Postgres so we know real model output clears the schema gates.
 *
 * Gated behind `CEREBRAS_LIVE=1 && LLM_API_KEY`. Neither flag is set in CI
 * or `just check`; run via `just smoke` (manual, opt-in only).
 *
 * Design:
 * - One `describe` per topic; one test per topic (chains all three procedures).
 * - `console.log` of the framework/baseline JSON so the human running the test
 *   can eyeball model output without re-running.
 * - Idempotency check: a second `generateBaseline` call must return from DB
 *   cache (< 200ms) without calling the LLM again.
 */

import { describe, test, expect, beforeAll } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { appRouter } from "./index";
import { userProfiles } from "@/db/schema";
import { SCOPING_TOPICS } from "@/lib/testing/topicPool";
import {
  assertFrameworkStructural,
  assertBaselineStructural,
  assertIdempotency,
} from "@/lib/testing/scopingInvariants";

// ---------------------------------------------------------------------------
// Gate: skip every test unless both flags are set.
// ---------------------------------------------------------------------------

const LIVE = process.env.CEREBRAS_LIVE === "1" && Boolean(process.env.LLM_API_KEY);

// Fixed test-user UUID — same pattern as the integration tests.
const LIVE_TEST_USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// Log which provider/model we're hitting so output is self-documenting.
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!LIVE) return;
  console.log("[live] provider base URL:", process.env.LLM_BASE_URL ?? "(default)");
  console.log("[live] model:", process.env.LLM_MODEL ?? "(default)");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE)("scoping flow — live Cerebras", () => {
  for (const topic of SCOPING_TOPICS) {
    describe(topic.slug, () => {
      test("clarify → generateFramework → generateBaseline + idempotency", async () => {
        await withTestDb(async (db) => {
          // Seed a test user (withTestDb truncates tables before each call).
          await db
            .insert(userProfiles)
            .values({ id: LIVE_TEST_USER, displayName: "Live Test User" });

          const caller = appRouter.createCaller({ userId: LIVE_TEST_USER });

          // ---------------------------------------------------------------
          // 1. clarify
          // ---------------------------------------------------------------
          const clarifyResult = await caller.course.clarify({ topic: topic.topic });

          // `clarify` returns `{ courseId, questions, nextStage }`.
          const { courseId, questions: clarifyingQuestions } = clarifyResult;

          expect(clarifyingQuestions.length, "clarify: question count ≥ 2").toBeGreaterThanOrEqual(
            2,
          );
          expect(clarifyingQuestions.length, "clarify: question count ≤ 4").toBeLessThanOrEqual(4);

          console.log(`[${topic.slug}] clarify questions:`, clarifyingQuestions);

          // ---------------------------------------------------------------
          // 2. generateFramework
          // ---------------------------------------------------------------
          // Cycle the answer pool by index — doesn't need to be semantically
          // perfect, just non-empty coherent text so the LLM can proceed.
          const answers = clarifyingQuestions.map(
            (_, i) => topic.answerPool[i % topic.answerPool.length]!,
          );

          const { framework } = await caller.course.generateFramework({ courseId, answers });

          assertFrameworkStructural(framework);
          console.log(`[${topic.slug}] framework:`, JSON.stringify(framework, null, 2));

          // ---------------------------------------------------------------
          // 3. generateBaseline
          // ---------------------------------------------------------------
          const { baseline } = await caller.course.generateBaseline({ courseId });

          assertBaselineStructural(baseline, framework);
          console.log(`[${topic.slug}] baseline:`, JSON.stringify(baseline, null, 2));

          // ---------------------------------------------------------------
          // 4. Idempotency — second call must hit DB, not LLM
          // ---------------------------------------------------------------
          const start = Date.now();
          const { baseline: cached } = await caller.course.generateBaseline({ courseId });
          assertIdempotency(Date.now() - start, `generateBaseline(${topic.slug})`);
          expect(cached, "idempotency: cached baseline equals original").toEqual(baseline);
        });
      });
    });
  }
});
