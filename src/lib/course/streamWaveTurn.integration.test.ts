import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoObjectGeneratedError } from "ai";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse, setCourseStartingState } from "@/db/queries/courses";
import { appendWaveChatLog, getWaveById, openWave } from "@/db/queries/waves";
import { appendMessage, getMessagesForWave, getNextTurnIndex } from "@/db/queries/contextMessages";
import { WAVE } from "@/lib/config/tuning";
import * as streamChatModule from "@/lib/llm/streamChat";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import type { WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import type { ExecuteTurnParams, ExecuteTurnResult } from "@/lib/turn/executeTurn";
import { streamWaveTurn } from "./streamWaveTurn";

/**
 * Integration tests for `streamWaveTurn` (plan: streaming-wave-turns Task 6).
 * Real Postgres testcontainer; the LLM boundary is mocked at `streamChat`
 * (mid-turns — `executeTurnStream` then runs for real, persisting production
 * -shaped context_messages rows) and at `executeTurn` (close turns, which
 * run the blocking path inside the stream). Assertions cover the UIMessage
 * part sequence AND the same DB row trails the blocking suite asserts.
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

/** Builds a StreamChatHandle whose partials/final are canned. */
function handleOf(partials: readonly unknown[], final: () => Promise<unknown>) {
  return {
    partialOutputStream: (async function* () {
      for (const p of partials) yield p;
    })(),
    final,
  };
}

/** Builds the error streamChat's final() rejects with on parse/validation failure. */
function noObjectError(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    text,
    response: { id: "t", timestamp: new Date(0), modelId: "mock" },
    usage: FAKE_USAGE,
    finishReason: "stop",
  });
}

/** Canned success handle for a mid-turn `parsed` emission. */
function midTurnHandle(parsed: WaveMidTurn) {
  return handleOf(
    // Two growing partials so the delta path is exercised.
    [{ userMessage: parsed.userMessage.slice(0, 3) }, { userMessage: parsed.userMessage }],
    async () => ({ parsed, text: JSON.stringify(parsed), usage: FAKE_USAGE }),
  );
}

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
  // 1. Happy mid-turn: text part lifecycle + transient result part + the same
  //    DB rows the blocking path persists (context_messages, chat_log).
  // -------------------------------------------------------------------------
  it("happy mid-turn: streams text parts, emits data-turn-result, persists both stores", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const parsed: WaveMidTurn = { userMessage: "Got it." };
      vi.spyOn(streamChatModule, "streamChat").mockResolvedValueOnce(
        midTurnHandle(parsed) as never,
      );
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

      // DB: context_messages rows (persisted by the REAL executeTurnStream).
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.map((r) => r.kind)).toEqual(["user_message", "assistant_response"]);
      // DB: chat_log dual-write — learner entry (pre-LLM) + assistant entry.
      const wave = await getWaveById(waveId);
      const log = wave.chatLog as WaveChatLog;
      expect(log.at(-1)).toEqual({ role: "assistant", kind: "text", content: "Got it." });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Validation retry: reset part with attempt 1 + two distinct text ids;
  //    the final result still lands.
  // -------------------------------------------------------------------------
  it("validation retry: emits data-turn-reset and re-streams under a new text id", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      const parsed: WaveMidTurn = { userMessage: "Second try." };
      vi.spyOn(streamChatModule, "streamChat")
        .mockResolvedValueOnce(
          handleOf([{ userMessage: "bad" }], async () => {
            throw noObjectError('{"wrong":1}');
          }) as never,
        )
        .mockResolvedValueOnce(midTurnHandle(parsed) as never);
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
    });
  });

  // -------------------------------------------------------------------------
  // 3. Close turn: blocking path inside the stream — result part only, no
  //    text parts.
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
      const streamSpy = vi.spyOn(streamChatModule, "streamChat");
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
      // The streaming LLM path is never touched on a close turn.
      expect(streamSpy).not.toHaveBeenCalled();
    });
  });
});
