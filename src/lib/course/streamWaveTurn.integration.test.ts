import { describe, it, expect, vi, beforeEach } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse, setCourseStartingState } from "@/db/queries/courses";
import { appendWaveChatLog, getWaveById, openWave } from "@/db/queries/waves";
import { appendMessage, getMessagesForWave, getNextTurnIndex } from "@/db/queries/contextMessages";
import { WAVE } from "@/lib/config/tuning";
import * as streamToolChatModule from "@/lib/llm/streamToolChat";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import type { StreamToolChatHandle, StreamToolChatOptions } from "@/lib/llm/streamToolChat";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import type { ExecuteTurnParams, ExecuteTurnResult } from "@/lib/turn/executeTurn";
import { streamWaveTurn } from "./streamWaveTurn";

/**
 * Integration tests for `streamWaveTurn` (plans: streaming-wave-turns Task 6,
 * tool-calling Task 6). Real Postgres testcontainer; the LLM boundary is
 * mocked at `streamToolChat` (mid-turns — `executeToolTurnStream` then runs
 * for real, persisting production-shaped context_messages rows INCLUDING the
 * tool kinds) and at `executeTurn` (close turns, which run the blocking path
 * inside the stream). Mock handles invoke the REAL tool executes so the
 * collector is staged exactly as `streamText` would stage it in production.
 * Assertions cover the UIMessage part sequence (text + tool chunks) AND the
 * same DB row trails the blocking suite asserts.
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

const FAKE_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/** A valid presentQuestionnaire tool input (post-validation shape). */
const QUIZ_INPUT = {
  questions: [
    {
      id: "q1",
      type: "multiple_choice" as const,
      prompt: "Which binding moves?",
      options: { A: "let", B: "const", C: "both", D: "neither" },
      correct: "A" as const,
      freetextRubric: "n/a",
      conceptName: "ownership",
      tier: 1,
    },
  ],
};

/** Seed user + course + open Wave 1. Returns the ids each test needs. */
async function seedCourseWithOpenWave(): Promise<{
  readonly courseId: string;
  readonly waveId: string;
}> {
  await db.insert(userProfiles).values({ id: USER_ID, displayName: "U" });
  const course = await createCourse({ userId: USER_ID, topic: "Rust" });
  await setCourseStartingState(course.id, {
    initialSummary: "seed",
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
 * One scripted attempt for the streamToolChat mock: fullStream parts to yield
 * (production `TextStreamPart` shapes) + the final step trail. `run` is
 * invoked with the attempt's REAL tools before parts are yielded, so tool
 * executes stage the collector mid-"stream", exactly like `streamText`.
 */
interface ScriptedAttempt {
  readonly parts: readonly { type: string; [k: string]: unknown }[];
  readonly steps: readonly {
    text: string;
    toolCalls: readonly unknown[];
    toolResults: readonly unknown[];
    content: readonly unknown[];
  }[];
  readonly run?: (tools: StreamToolChatOptions["tools"]) => Promise<void>;
}

/** Queue scripted attempts onto the streamToolChat spy (one per LLM attempt). */
function mockToolChatAttempts(...attempts: readonly ScriptedAttempt[]) {
  const spy = vi.spyOn(streamToolChatModule, "streamToolChat");
  attempts.forEach((attempt) => {
    spy.mockImplementationOnce(async (_messages, opts): Promise<StreamToolChatHandle> => {
      return {
        fullStream: (async function* () {
          await attempt.run?.(opts.tools);
          for (const p of attempt.parts) yield p as never;
        })(),
        final: async () => ({
          text: attempt.steps[attempt.steps.length - 1]?.text ?? "",
          steps: attempt.steps as never,
          usage: FAKE_USAGE,
        }),
      };
    });
  });
  return spy;
}

/** fullStream text-delta part (note: `text`, not `delta`, at this layer). */
const textDelta = (text: string) => ({ type: "text-delta", id: "t0", text });

/** Minimal recording writer satisfying UIMessageStreamWriter for assertions. */
function recordingWriter() {
  const parts: { type: string; [k: string]: unknown }[] = [];
  return {
    parts,
    writer: {
      write: (part: { type: string }) => {
        parts.push(part);
      },
      merge: () => undefined,
      onError: undefined,
    } as never,
  };
}

/**
 * Blocking-path executeTurn mock for close turns (mirrors the blocking
 * suite): persists user + assistant rows so executeWaveClose sees
 * production-shaped context_messages.
 */
function makeBlockingTurnMock(parsed: unknown) {
  return async <T>(params: ExecuteTurnParams<T>): Promise<ExecuteTurnResult<T>> => {
    if (params.parent.kind !== "wave") throw new Error("test mock: wave only");
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
    return { parsed: parsed as T, usage: FAKE_USAGE };
  };
}

describe("streamWaveTurn (integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Happy mid-turn (pure teaching, no tool calls): text part lifecycle +
  //    transient result part + the same DB rows the blocking path persists.
  // -------------------------------------------------------------------------
  it("happy mid-turn: streams text parts, emits data-turn-result, persists both stores", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      mockToolChatAttempts({
        parts: [textDelta("Got"), textDelta(" it.")],
        steps: [{ text: "Got it.", toolCalls: [], toolResults: [], content: [] }],
      });
      const { parts, writer } = recordingWriter();

      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: { kind: "chat-text", text: "tell me about ownership" },
        },
        writer,
      );

      // Part sequence: text-start, ≥1 text-delta, text-end, data-turn-result.
      const types = parts.map((p) => p.type);
      expect(types[0]).toBe("text-start");
      expect(types).toContain("text-delta");
      expect(types.at(-2)).toBe("text-end");
      expect(types.at(-1)).toBe("data-turn-result");
      // Deltas reassemble the prose.
      const streamedText = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p["delta"])
        .join("");
      expect(streamedText).toBe("Got it.");
      // The result part matches the blocking mutation's projection.
      const resultPart = parts.at(-1)!;
      expect(resultPart["transient"]).toBe(true);
      expect(resultPart["data"]).toMatchObject({
        kind: "mid-turn",
        assistantContent: "Got it.",
        turnsRemaining: WAVE.turnCount - 1,
      });

      // DB: context_messages rows (persisted by the REAL executeToolTurnStream).
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.map((r) => r.kind)).toEqual(["user_message", "assistant_response"]);
      // DB: chat_log dual-write — learner entry (pre-LLM) + assistant entry.
      const wave = await getWaveById(waveId);
      const log = wave.chatLog as WaveChatLog;
      expect(log.at(-1)).toEqual({ role: "assistant", kind: "text", content: "Got it." });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Questionnaire tool turn: tool chunks forward to the writer, the REAL
  //    execute stages the collector, tool-kind rows persist, chat_log carries
  //    the questionnaire entry, the result projects it.
  // -------------------------------------------------------------------------
  it("questionnaire turn: forwards tool chunks, persists tool rows + questionnaire", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      mockToolChatAttempts({
        // Prose before the call, tool lifecycle, short wrap-up after — the
        // shape the probe observed (median 2 steps).
        parts: [
          textDelta("Let's check. "),
          { type: "tool-input-start", id: "c1", toolName: "presentQuestionnaire" },
          { type: "tool-input-delta", id: "c1", delta: '{"questions":' },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "presentQuestionnaire",
            input: QUIZ_INPUT,
          },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "presentQuestionnaire",
            input: QUIZ_INPUT,
            output: { accepted: true, questionCount: 1 },
          },
          textDelta("Quiz below!"),
        ],
        steps: [
          {
            text: "Let's check. ",
            toolCalls: [{ toolCallId: "c1", toolName: "presentQuestionnaire", input: QUIZ_INPUT }],
            toolResults: [
              {
                toolCallId: "c1",
                toolName: "presentQuestionnaire",
                output: { accepted: true, questionCount: 1 },
              },
            ],
            content: [],
          },
          { text: "Quiz below!", toolCalls: [], toolResults: [], content: [] },
        ],
        // Stage the collector through the REAL tool execute, as streamText would.
        run: async (tools) => {
          await tools["presentQuestionnaire"]!.execute!(QUIZ_INPUT, {
            toolCallId: "c1",
            messages: [],
          });
        },
      });
      const { parts, writer } = recordingWriter();

      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: { kind: "chat-text", text: "quiz me" },
        },
        writer,
      );

      // Tool chunk lifecycle reached the client in order. NO tool-input-delta:
      // raw input deltas carry the plaintext `correct` key and are dropped.
      const toolTypes = parts.map((p) => p.type).filter((t) => t.startsWith("tool-"));
      expect(toolTypes).toEqual([
        "tool-input-start",
        "tool-input-available",
        "tool-output-available",
      ]);
      const inputAvailable = parts.find((p) => p.type === "tool-input-available")!;
      expect(inputAvailable["toolCallId"]).toBe("c1");
      expect(inputAvailable["toolName"]).toBe("presentQuestionnaire");
      // The forwarded input is the allowlist-redacted projection: grading
      // keys (`correct`, `freetextRubric`) and conceptName never cross the wire.
      expect(inputAvailable["input"]).toEqual({
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "Which binding moves?",
            options: { A: "let", B: "const", C: "both", D: "neither" },
            tier: 1,
          },
        ],
      });

      // Result projection: the full streamed prose + the new questionnaire.
      const resultPart = parts.at(-1)!;
      expect(resultPart.type).toBe("data-turn-result");
      const data = resultPart["data"] as {
        assistantContent: string;
        newQuestionnaire: { questions: readonly unknown[] } | null;
      };
      expect(data.assistantContent).toBe("Let's check. Quiz below!");
      expect(data.newQuestionnaire?.questions).toHaveLength(1);

      // DB: the loop trail persists with tool kinds at one turn_index.
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.map((r) => r.kind)).toEqual([
        "user_message",
        "assistant_tool_call",
        "tool_result",
        "assistant_response",
      ]);
      // chat_log carries the questionnaire entry with the FULL streamed prose.
      const wave = await getWaveById(waveId);
      const log = wave.chatLog as WaveChatLog;
      expect(log.at(-1)).toMatchObject({
        role: "assistant",
        kind: "text_with_questionnaire",
        content: "Let's check. Quiz below!",
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Validation retry (gate: empty prose): reset part with attempt 1 + two
  //    distinct text ids; retry exhaust persists; the final result still lands.
  // -------------------------------------------------------------------------
  it("validation retry: emits data-turn-reset and re-streams under a new text id", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      mockToolChatAttempts(
        // Attempt 0: the loop ends with NO learner-visible prose → gate fails.
        { parts: [], steps: [{ text: "", toolCalls: [], toolResults: [], content: [] }] },
        // Attempt 1: clean teaching turn.
        {
          parts: [textDelta("Second try.")],
          steps: [{ text: "Second try.", toolCalls: [], toolResults: [], content: [] }],
        },
      );
      const { parts, writer } = recordingWriter();

      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: { kind: "chat-text", text: "hi" },
        },
        writer,
      );

      const resets = parts.filter((p) => p.type === "data-turn-reset");
      expect(resets).toHaveLength(1);
      expect(resets[0]!["data"]).toEqual({ attempt: 1 });
      const textStarts = parts.filter((p) => p.type === "text-start");
      expect(textStarts).toHaveLength(2);
      expect(textStarts[0]!["id"]).not.toBe(textStarts[1]!["id"]);
      // Every text-start is closed by a matching text-end.
      const textEnds = parts.filter((p) => p.type === "text-end");
      expect(textEnds.map((p) => p["id"])).toEqual(textStarts.map((p) => p["id"]));
      expect(parts.at(-1)!["data"]).toMatchObject({ kind: "mid-turn" });

      // DB: the failed attempt persists as ONE JSON envelope + directive —
      // never as tool-kind rows (cache-prefix invariant).
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.map((r) => r.kind)).toEqual([
        "user_message",
        "failed_assistant_response",
        "harness_retry_directive",
        "assistant_response",
      ]);
      const directive = ctxRows[2]!;
      expect(directive.content).toContain("teaching prose");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Close turn: blocking path inside the stream — result part only, no
  //    text parts, tool loop never touched.
  // -------------------------------------------------------------------------
  it("close turn: emits only data-turn-result (kind close-turn), no text parts", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Seed WAVE.turnCount - 1 consumed learner turns (both stores, matching
      // production shape) so this submission is the close turn.
      await Array.from({ length: WAVE.turnCount - 1 }).reduce<Promise<void>>(
        async (accP, _v, i) => {
          await accP;
          await appendMessage({
            parent: { kind: "wave", id: waveId },
            turnIndex: i,
            seq: 0,
            kind: "user_message",
            role: "user",
            content: `<learner_reply>past turn ${i}</learner_reply>`,
          });
          await appendWaveChatLog(db, waveId, {
            role: "user",
            kind: "text",
            content: `past turn ${i}`,
          });
        },
        Promise.resolve(),
      );

      const closeParsed: WaveCloseTurn = {
        userMessage: "Closing chat.",
        summary: "We covered ownership.",
        gradings: [],
        nextUnitBlueprint: {
          topic: "Borrowing rules",
          outline: ["borrow"],
          openingText: "Welcome to lesson 2.",
          plannedConcepts: [{ name: "ownership", tier: 1, role: "fresh" }],
        },
        conceptUpdates: [],
      };
      vi.spyOn(executeTurnModule, "executeTurn").mockImplementation(
        makeBlockingTurnMock(closeParsed) as unknown as typeof executeTurnModule.executeTurn,
      );
      const toolChatSpy = vi.spyOn(streamToolChatModule, "streamToolChat");
      const { parts, writer } = recordingWriter();

      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: { kind: "chat-text", text: "last reply" },
        },
        writer,
      );

      expect(parts).toHaveLength(1);
      expect(parts[0]!.type).toBe("data-turn-result");
      expect(parts[0]!["data"]).toMatchObject({
        kind: "close-turn",
        closingMessage: "Closing chat.",
        nextWaveNumber: 2,
      });
      // The streaming tool loop is never touched on a close turn.
      expect(toolChatSpy).not.toHaveBeenCalled();
    });
  });
});
