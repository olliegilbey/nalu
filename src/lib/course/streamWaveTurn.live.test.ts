/**
 * Live smoke for ONE tool-loop teaching turn (`streamWaveTurn` against real
 * Cerebras + testcontainers Postgres) — plan: tool-calling Task 8 Step 1.
 *
 * WHY separate from wave.live.test.ts: that suite drives the BLOCKING
 * mega-schema path end-to-end (scoping → full wave). This test seeds a wave
 * directly (no scoping LLM calls) and exercises the streaming tool channel:
 * per the plan, assertions are on COLLECTOR OUTCOMES (staged questionnaire /
 * turn projection / persisted row kinds) and on wire-safety invariants
 * (redaction, text-channel leak guard), never on prose content — the model
 * may or may not call presentQuestionnaire on any given run (probe: ~5%
 * no-call), so structure is asserted conditionally and logged.
 *
 * Gated behind `CEREBRAS_LIVE=1 && LLM_API_KEY`; never runs in CI/`just check`.
 */

import { describe, test, expect, beforeAll } from "vitest";
import type { UIMessageStreamWriter } from "ai";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse, setCourseStartingState } from "@/db/queries/courses";
import { openWave } from "@/db/queries/waves";
import { getMessagesForWave } from "@/db/queries/contextMessages";
import { userIdStore } from "@/lib/llm/userIdStore";
import { WAVE } from "@/lib/config/tuning";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";
import { findJsonProseLeakIndex } from "./waveMidTurnGate";
import { streamWaveTurn } from "./streamWaveTurn";

const LIVE = process.env.CEREBRAS_LIVE === "1" && Boolean(process.env.LLM_API_KEY);

// Distinct from other live suites' users (defence-in-depth vs truncation smear).
const LIVE_TEST_USER = "dddddddd-dddd-dddd-dddd-dddddddddddd";

/** Minimal open-wave seed — mirrors the integration suite's fixture shape. */
const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["ownership"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["borrowing"] },
  ],
} as const;

beforeAll(() => {
  if (!LIVE) return;
  console.log("[live] provider base URL:", process.env.LLM_BASE_URL ?? "(default)");
  console.log("[live] model:", process.env.LLM_MODEL ?? "(default)");
});

describe.skipIf(!LIVE)("streamWaveTurn tool loop — live Cerebras", () => {
  test("one mid-turn: tool-channel outcomes staged, wire redaction holds", async () => {
    await withTestDb(async () => {
      await db
        .insert(userProfiles)
        .values({ id: LIVE_TEST_USER, displayName: "Live Test User (tool-loop)" });
      const course = await createCourse({ userId: LIVE_TEST_USER, topic: "Rust ownership" });
      await setCourseStartingState(course.id, {
        initialSummary: "Learner knows basic syntax; start at ownership fundamentals.",
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
            outline: ["moves", "drops"],
            openingText: "Welcome! Let's learn ownership.",
            plannedConcepts: [{ name: "ownership", tier: 1, role: "fresh" as const }],
          },
        },
        turnBudget: WAVE.turnCount,
      });

      // Recording writer — same seam the integration suite uses; here it
      // captures REAL model traffic for the wire-safety assertions.
      const parts: { type: string; [k: string]: unknown }[] = [];
      const writer = {
        write: (part: { type: string }) => {
          parts.push(part);
        },
        merge: () => undefined,
        onError: undefined,
      } as unknown as UIMessageStreamWriter<WaveTurnUIMessage>;

      // ALS wrap mirrors the streaming route (rate-limiter lane resolution).
      await userIdStore.run(LIVE_TEST_USER, () =>
        streamWaveTurn(
          {
            userId: LIVE_TEST_USER,
            courseId: course.id,
            waveNumber: 1,
            // Nudge toward the questionnaire tool; the assertion below stays
            // conditional anyway (probe: ~5% of turns teach without calling).
            payload: {
              kind: "chat-text",
              text: "Teach me one small idea, then quiz me with one multiple-choice question.",
            },
          },
          writer,
        ),
      );

      // Turn projection: the stream must end with a mid-turn result part.
      const resultPart = parts.at(-1)!;
      expect(resultPart.type, "stream ends with data-turn-result").toBe("data-turn-result");
      const data = resultPart["data"] as {
        kind: string;
        assistantContent: string;
        newQuestionnaire: { questions: readonly Record<string, unknown>[] } | null;
      };
      expect(data.kind, "mid-turn projection").toBe("mid-turn");
      expect(data.assistantContent.length, "learner-visible prose non-empty").toBeGreaterThan(0);

      // Wire safety 1 — text channel: the forwarded prose must never contain
      // an unfenced line-start JSON dump (the leak guard's invariant).
      const forwardedText = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p["delta"] as string)
        .join("");
      expect(
        findJsonProseLeakIndex(forwardedText),
        "no unfenced JSON in forwarded text",
      ).toBeNull();

      // Wire safety 2 — tool channel: no raw input deltas; questionnaire
      // inputs cross the wire redacted (grading keys stripped).
      expect(
        parts.some((p) => p.type === "tool-input-delta"),
        "tool-input-delta never forwarded",
      ).toBe(false);
      const questionnaireInputs = parts.filter(
        (p) => p.type === "tool-input-available" && p["toolName"] === "presentQuestionnaire",
      );
      questionnaireInputs.forEach((p) => {
        const serialized = JSON.stringify(p["input"]);
        expect(serialized, "no correct key on the wire").not.toContain('"correct"');
        expect(serialized, "no rubric on the wire").not.toContain('"freetextRubric"');
      });

      // Collector outcome: IF the model called presentQuestionnaire, the
      // staged questionnaire must have projected into the result and persisted
      // tool-kind rows must exist at this turn.
      const ctxRows = await getMessagesForWave(wave.id);
      const kinds = ctxRows.map((r) => r.kind);
      expect(kinds[0], "turn begins with the user envelope").toBe("user_message");
      expect(kinds.at(-1), "turn ends with the assistant prose row").toBe("assistant_response");
      if (data.newQuestionnaire !== null) {
        expect(
          data.newQuestionnaire.questions.length,
          "staged questionnaire has questions",
        ).toBeGreaterThan(0);
        expect(kinds, "tool call persisted").toContain("assistant_tool_call");
        expect(kinds, "tool result persisted").toContain("tool_result");
      }

      // Forensic summary (mirrors wave.live.test.ts style).
      process.stderr.write(
        `[tool-loop-smoke] DONE questionnaireStaged=${data.newQuestionnaire !== null} ` +
          `rowKinds=${kinds.join(",")} ` +
          `forwardedTextChars=${forwardedText.length}\n`,
      );
    });
  }, 300_000); // one tool loop = up to LLM.maxToolSteps provider calls + retries
});
