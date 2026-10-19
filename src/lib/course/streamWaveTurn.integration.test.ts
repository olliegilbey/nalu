import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { withTestDb } from "@/db/testing/withTestDb";
import { db } from "@/db/client";
import { userProfiles } from "@/db/schema";
import { createCourse, getCourseById } from "@/db/queries/courses";
import { incrementCourseXpInTx, setCourseStartingStateInTx } from "@/db/queries/courses.tx";
import { appendWaveChatLog, openWave } from "@/db/queries/waves.writes";
import { getWaveById } from "@/db/queries/waves";
import { appendMessage } from "@/db/queries/contextMessages.writes";
import { getMessagesForWave, getNextTurnIndex } from "@/db/queries/contextMessages";
import { upsertConcept } from "@/db/queries/concepts.writes";
import { getAssessmentByWaveAndQuestionId } from "@/db/queries/assessments";
import { WAVE } from "@/lib/config/tuning";
import { calculateMcXp } from "@/lib/scoring/xp";
import * as waveMidTurnAgentModule from "@/lib/agents/waveMidTurnAgent";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import type { WaveMidTurnAgentTools } from "@/lib/agents/waveMidTurnAgent";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import type { LlmMessage } from "@/lib/types/llm";
import type { ExecuteTurnParams, ExecuteTurnResult } from "@/lib/turn/executeTurn";
import { streamWaveTurn } from "./streamWaveTurn";
import { namespaceQuestionId } from "./namespaceQuestionId";

// The provider model needs env at build time; the stubbed agent stream never
// calls it. llmProviderOptions stays real, so the sent cache key is the true one.
vi.mock("@/lib/llm/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/provider")>()),
  getLlmModel: () => ({ modelId: "stub", specificationVersion: "v3" }),
}));

/**
 * Integration tests for `streamWaveTurn` (plans: streaming-wave-turns Task 6,
 * tool-calling Task 6, agent-loop Task 4). Real Postgres testcontainer; the
 * LLM boundary is mocked at `buildWaveMidTurnAgent` (mid-turns — the REAL
 * builder runs, only the agent's `.stream()` is stubbed, so
 * `executeToolTurnStream` persists production-shaped context_messages rows
 * INCLUDING the tool kinds) and at `executeTurn` (close turns, which run
 * it blocking inside the stream). Scripted attempts invoke the REAL tool
 * executes (collector staging AND DB-backed lookups) so state moves exactly
 * as `streamText` would move it in production. Assertions cover the UIMessage
 * part sequence (text + tool chunks) AND the DB row trails each turn leaves.
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

/** A recordComprehensionSignals tool input grading QUIZ_INPUT's q1. */
const SIGNALS_INPUT = {
  signals: [
    {
      kind: "mc-index" as const,
      questionId: "q1",
      rationale: "Knows let moves. Teach borrowing next.",
    },
  ],
};

/** The learner's answer to QUIZ_INPUT: q1 = "A", its `correct` key. */
function correctAnswerPayload(questionnaireId: string) {
  return {
    kind: "questionnaire-answers" as const,
    questionnaireId,
    answers: [{ id: "q1", kind: "mc" as const, selected: "A" as const }],
  };
}

/** Seed user + course + open Wave 1. Returns the ids each test needs. */
async function seedCourseWithOpenWave(): Promise<{
  readonly courseId: string;
  readonly waveId: string;
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
 * One scripted attempt for the agent-builder mock: fullStream parts to yield
 * (production `TextStreamPart` shapes) + the final step trail. `run` is
 * invoked with the attempt's REAL agent tools before parts are yielded, so
 * tool executes stage the collector / hit the test DB mid-"stream", exactly
 * like `streamText`.
 */
interface ScriptedAttempt {
  readonly parts: readonly { type: string; [k: string]: unknown }[];
  readonly steps: readonly {
    text: string;
    toolCalls: readonly unknown[];
    toolResults: readonly unknown[];
    content: readonly unknown[];
  }[];
  readonly run?: (tools: WaveMidTurnAgentTools) => Promise<void>;
}

/** Messages each stubbed `agent.stream()` received, in dispatch order. */
const streamedMessages: LlmMessage[][] = [];

/**
 * Mock the agent SEAM: the REAL `buildWaveMidTurnAgent` runs (real collector,
 * real tools, real instructions), and only the returned agent's `.stream()`
 * is replaced with the scripted attempt — one per dispatch, in order.
 */
function mockAgentAttempts(...attempts: readonly ScriptedAttempt[]) {
  // Capture the original BEFORE installing the spy: the named import is a
  // live binding and would recurse into the mock once spied.
  const realBuild = waveMidTurnAgentModule.buildWaveMidTurnAgent;
  const dispatchState = { next: 0 };
  return vi.spyOn(waveMidTurnAgentModule, "buildWaveMidTurnAgent").mockImplementation((params) => {
    const instance = realBuild(params);
    const agent = {
      stream: async ({ messages }: { messages: LlmMessage[] }) => {
        const attempt = attempts[dispatchState.next];
        dispatchState.next += 1;
        if (!attempt) throw new Error("mockAgentAttempts: unscripted dispatch");
        streamedMessages.push(messages);
        return {
          fullStream: (async function* () {
            await attempt.run?.(instance.agent.tools);
            for (const p of attempt.parts) yield p as never;
          })(),
          steps: Promise.resolve(attempt.steps as never),
          totalUsage: Promise.resolve(FAKE_USAGE),
        };
      },
    };
    return { ...instance, agent: agent as never };
  });
}

/** fullStream text-delta part (note: `text`, not `delta`, at this layer). */
const textDelta = (text: string) => ({ type: "text-delta", id: "t0", text });

/**
 * Scripted attempt that runs one emission tool through its REAL execute,
 * then writes `prose`. Two steps: the tool call, then the closing text.
 */
function toolCallAttempt(
  toolName: "presentQuestionnaire" | "recordComprehensionSignals",
  input: unknown,
  output: unknown,
  prose: string,
): ScriptedAttempt {
  return {
    parts: [textDelta(prose)],
    steps: [
      {
        text: "",
        toolCalls: [{ toolCallId: `${toolName}-1`, toolName, input }],
        toolResults: [{ toolCallId: `${toolName}-1`, toolName, output }],
        // The SDK lists results in `content`; toolStepRows reads them there.
        content: [{ type: "tool-result", toolCallId: `${toolName}-1`, toolName, output }],
      },
      { text: prose, toolCalls: [], toolResults: [], content: [] },
    ],
    run: async (tools) => {
      await tools[toolName]!.execute!(input as never, {
        toolCallId: `${toolName}-1`,
        messages: [],
      });
    },
  };
}

/** A rubric string that must never reach the client (#169). */
const SECRET_RUBRIC = "Full marks only if the answer names move semantics.";

/**
 * A presentQuestionnaire input that fails the tool's superRefine: q1 has no
 * conceptName. It still carries a plaintext answer key and rubric.
 */
const INVALID_QUIZ_INPUT = {
  questions: [
    {
      id: "q1",
      type: "multiple_choice",
      prompt: "Which binding moves?",
      options: { A: "let", B: "const", C: "both", D: "neither" },
      correct: "B",
      freetextRubric: SECRET_RUBRIC,
    },
  ],
};

/** Fails when any chunk written to the client carries a quiz secret. */
function expectNoQuizSecrets(parts: readonly unknown[]): void {
  // Unescape, so a secret nested in a string field such as errorText matches.
  const wire = JSON.stringify(parts).replaceAll('\\"', '"');
  expect(wire).not.toContain('"correct":"B"');
  expect(wire).not.toContain(SECRET_RUBRIC);
}

/** Token usage every mocked Step reports. */
const STEP_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

/**
 * Two-Step model: an invalid presentQuestionnaire call, then closing prose
 * once the SDK feeds the validation error back. A function, not the mock's
 * array form, so each Step picks its chunks by call count.
 */
function invalidQuizThenProseModel(): MockLanguageModelV3 {
  const finish = (unified: "tool-calls" | "stop"): LanguageModelV3StreamPart => ({
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: STEP_USAGE,
  });
  const toolCallStep: readonly LanguageModelV3StreamPart[] = [
    {
      type: "tool-call",
      toolCallId: "c1",
      toolName: "presentQuestionnaire",
      input: JSON.stringify(INVALID_QUIZ_INPUT),
    },
    finish("tool-calls"),
  ];
  const proseStep: readonly LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Let's keep going." },
    { type: "text-end", id: "t1" },
    finish("stop"),
  ];
  const model: MockLanguageModelV3 = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [...(model.doStreamCalls.length === 1 ? toolCallStep : proseStep)],
      }),
    }),
  });
  return model;
}

/**
 * Mock the agent's MODEL, not its stream: the REAL builder and the REAL SDK
 * loop run, so tool-input parsing and its errors are production-shaped.
 */
function mockAgentModel(model: MockLanguageModelV3) {
  // Capture the original before spying; see mockAgentAttempts.
  const realBuild = waveMidTurnAgentModule.buildWaveMidTurnAgent;
  return vi
    .spyOn(waveMidTurnAgentModule, "buildWaveMidTurnAgent")
    .mockImplementation((params) => realBuild({ ...params, model }));
}

/** Scripted attempt whose stream dies mid-flight, like a dropped connection. */
const failingAttempt: ScriptedAttempt = {
  parts: [],
  steps: [],
  run: () => Promise.reject(new Error("LLM transport failure")),
};

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
 * executeTurn mock for close turns: persists user + assistant rows so
 * executeWaveClose sees production-shaped context_messages.
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

/**
 * Seed `count` consumed learner chat turns on a Wave, in both stores, as
 * production leaves them. Each consumes one turn of the Wave's budget.
 */
async function seedPastChatTurns(waveId: string, count: number): Promise<void> {
  await Array.from({ length: count }).reduce<Promise<void>>(async (accP, _v, i) => {
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
  }, Promise.resolve());
}

/**
 * Run one chat turn whose scripted attempt presents a quiz. Returns the new
 * questionnaire's id. The caller scripts that attempt with `mockAgentAttempts`.
 */
async function presentQuiz(courseId: string): Promise<string> {
  const { parts, writer } = recordingWriter();
  await streamWaveTurn(
    { userId: USER_ID, courseId, waveNumber: 1, payload: { kind: "chat-text", text: "quiz me" } },
    writer,
  );
  const data = parts.at(-1)!["data"] as {
    newQuestionnaire: { questionnaireId: string } | null;
  };
  return data.newQuestionnaire!.questionnaireId;
}

/** XP a learner already holds before the Wave. A non-zero start tells a total from a delta. */
const PRIOR_XP = 30;

/** XP for a correct answer to QUIZ_INPUT's MC question, at its tier. */
const QUIZ_MC_XP = calculateMcXp(QUIZ_INPUT.questions[0]!.tier, true);

/** The `data-turn-result` part's `totalXp`, plus `courses.total_xp` after the turn. */
async function readTotals(
  parts: readonly { type: string; [k: string]: unknown }[],
  courseId: string,
): Promise<{ readonly fromResult: unknown; readonly fromDb: number }> {
  const resultPart = parts.at(-1)!;
  expect(resultPart.type).toBe("data-turn-result");
  const data = resultPart["data"] as { totalXp?: unknown };
  return { fromResult: data.totalXp, fromDb: (await getCourseById(courseId)).totalXp };
}

describe("streamWaveTurn (integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    streamedMessages.length = 0;
  });

  // -------------------------------------------------------------------------
  // 1. Happy mid-turn (pure teaching, no tool calls): text part lifecycle +
  //    transient result part + the rows in both stores.
  // -------------------------------------------------------------------------
  it("happy mid-turn: streams text parts, emits data-turn-result, persists both stores", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      mockAgentAttempts({
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
      mockAgentAttempts({
        // Prose before the call, tool lifecycle, short wrap-up after — the
        // shape the probe observed (median 2 steps).
        parts: [
          // A grading-signal call on the stream only (forwarding reads the
          // parts; persistence reads `steps`). It must not reach the client:
          // grading signals have no client consumer (issue #59).
          { type: "tool-input-start", id: "s1", toolName: "recordComprehensionSignals" },
          {
            type: "tool-call",
            toolCallId: "s1",
            toolName: "recordComprehensionSignals",
            input: { signals: [] },
          },
          {
            type: "tool-result",
            toolCallId: "s1",
            toolName: "recordComprehensionSignals",
            input: { signals: [] },
            output: { recorded: 0 },
          },
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
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "presentQuestionnaire",
                output: { accepted: true, questionCount: 1 },
              },
            ],
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

      // Only the questionnaire's tool chunk lifecycle reached the client, in
      // order. NO tool-input-delta: raw input deltas carry the plaintext
      // `correct` key and are dropped.
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
  // 2b. Lookup turn (agent-loop Task 4): the REAL getConceptHistory execute
  //     hits the test DB; the loop trail persists as tool-kind rows; the NEXT
  //     turn's dispatched messages replay the lookup (context fidelity) and
  //     carry no system message (the agent's instructions own that slot).
  //     getConceptHistory, since default "full" mode offers no getDueConcepts
  //     (audit F4).
  // -------------------------------------------------------------------------
  it("lookup turn: getConceptHistory rows persist and feed the next turn's context", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Seed one concept, never assessed, so the real lookup resolves its name.
      await upsertConcept({ courseId, name: "ownership", tier: 1 });

      // Canned steps mirror what the REAL execute returns for the seeded row
      // (asserted below) — persistence reads the step trail, not the execute.
      const lookupInput = { conceptName: "ownership" };
      const lookupOutput = { conceptName: "ownership", attempts: [] };
      const captured: { lookup: unknown } = { lookup: null };
      mockAgentAttempts(
        {
          parts: [
            { type: "tool-input-start", id: "l1", toolName: "getConceptHistory" },
            {
              type: "tool-call",
              toolCallId: "l1",
              toolName: "getConceptHistory",
              input: lookupInput,
            },
            {
              type: "tool-result",
              toolCallId: "l1",
              toolName: "getConceptHistory",
              input: lookupInput,
              output: lookupOutput,
            },
            textDelta("Let's revisit ownership."),
          ],
          steps: [
            {
              text: "",
              toolCalls: [{ toolCallId: "l1", toolName: "getConceptHistory", input: lookupInput }],
              toolResults: [
                { toolCallId: "l1", toolName: "getConceptHistory", output: lookupOutput },
              ],
              content: [
                {
                  type: "tool-result",
                  toolCallId: "l1",
                  toolName: "getConceptHistory",
                  output: lookupOutput,
                },
              ],
            },
            { text: "Let's revisit ownership.", toolCalls: [], toolResults: [], content: [] },
          ],
          // Drive the REAL lookup execute against the testcontainer DB.
          run: async (tools) => {
            captured.lookup = await tools.getConceptHistory.execute!(lookupInput, {
              toolCallId: "l1",
              messages: [],
            });
          },
        },
        // Turn 2: plain teaching — exists to capture the messages the next
        // dispatch assembles from the persisted turn-1 trail.
        {
          parts: [textDelta("Onwards.")],
          steps: [{ text: "Onwards.", toolCalls: [], toolResults: [], content: [] }],
        },
      );

      const first = recordingWriter();
      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: { kind: "chat-text", text: "review something" },
        },
        first.writer,
      );

      // The real execute resolved the seeded concept by name (no attempts yet).
      expect(captured.lookup).toEqual(lookupOutput);
      // Lookup tool chunks stay server-side (issue #59): only
      // presentQuestionnaire has a client consumer, so nothing else crosses.
      const toolTypes = first.parts.map((p) => p.type).filter((t) => t.startsWith("tool-"));
      expect(toolTypes).toEqual([]);

      // The loop trail persisted with tool kinds; contents name the lookup.
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.map((r) => r.kind)).toEqual([
        "user_message",
        "assistant_tool_call",
        "tool_result",
        "assistant_response",
      ]);
      expect(ctxRows[1]!.content).toContain("getConceptHistory");
      expect(ctxRows[2]!.content).toContain("ownership");

      // Turn 2: the dispatched context replays the lookup call + result.
      const second = recordingWriter();
      await streamWaveTurn(
        { userId: USER_ID, courseId, waveNumber: 1, payload: { kind: "chat-text", text: "go on" } },
        second.writer,
      );
      const turn2Messages = streamedMessages.at(-1)!;
      // No system message crosses the wire in `messages` — the agent's
      // instructions carry it (double-send would break the cache prefix).
      expect(turn2Messages.some((m) => m.role === "system")).toBe(false);
      const replayedCall = turn2Messages.find(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "tool-call" && p.toolName === "getConceptHistory"),
      );
      expect(replayedCall).toBeDefined();
      const replayedResult = turn2Messages.find((m) => m.role === "tool");
      expect(JSON.stringify(replayedResult?.content)).toContain("ownership");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Validation retry (gate: empty prose): reset part with attempt 1 + two
  //    distinct text ids; retry exhaust persists; the final result still lands.
  // -------------------------------------------------------------------------
  it("validation retry: emits data-turn-reset and re-streams under a new text id", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      mockAgentAttempts(
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
      // NON-transient: the marker must land in the message's parts array —
      // the client slices on its position to hide failed-attempt output.
      expect(resets[0]!["transient"]).toBeUndefined();
      const textStarts = parts.filter((p) => p.type === "text-start");
      expect(textStarts).toHaveLength(2);
      expect(textStarts[0]!["id"]).not.toBe(textStarts[1]!["id"]);
      // Every text-start is closed by a matching text-end.
      const textEnds = parts.filter((p) => p.type === "text-end");
      expect(textEnds.map((p) => p["id"])).toEqual(textStarts.map((p) => p["id"]));
      expect(parts.at(-1)!["data"]).toMatchObject({ kind: "mid-turn" });

      // DB: the failed attempt persists as ONE prose row + directive —
      // never as tool-kind rows (cache-prefix invariant). It showed no
      // prose, so its row is empty.
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.map((r) => r.kind)).toEqual([
        "user_message",
        "failed_assistant_response",
        "harness_retry_directive",
        "assistant_response",
      ]);
      expect(ctxRows[1]!.content).toBe("");
      const directive = ctxRows[2]!;
      expect(directive.content).toContain("teaching prose");
    });
  });

  // -------------------------------------------------------------------------
  // 3b. Leak guard: a JSON-imitation attempt dumps the would-be tool input
  //     (answer key included) into the TEXT channel. Deltas from the unfenced
  //     line-start `{` onward must NOT cross the wire; the gate then retries.
  //     Persistence records the failed prose cut at the same index (#140).
  // -------------------------------------------------------------------------
  it("json-imitation attempt: withholds leaked text deltas, gate retries clean", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const leakedJson = '{"questions": [{"id": "q1", "correct": "C"}]}';
      mockAgentAttempts(
        // Attempt 0: greeting prose, then the raw JSON dump — the live-observed
        // failure shape (2026-07-08, transformers dev wave).
        {
          parts: [textDelta("Here you go!\n"), textDelta(leakedJson)],
          steps: [
            {
              text: `Here you go!\n${leakedJson}`,
              toolCalls: [],
              toolResults: [],
              content: [],
            },
          ],
        },
        // Attempt 1: clean teaching turn.
        {
          parts: [textDelta("Clean retry.")],
          steps: [{ text: "Clean retry.", toolCalls: [], toolResults: [], content: [] }],
        },
      );
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

      // The answer key never crossed the wire: only the safe prefix of
      // attempt 0 plus the whole of attempt 1 were forwarded.
      const forwarded = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p["delta"] as string);
      expect(forwarded.join("")).toBe("Here you go!\nClean retry.");
      expect(forwarded.some((d) => d.includes("correct"))).toBe(false);
      expect(parts.filter((p) => p.type === "data-turn-reset")).toHaveLength(1);

      // The failed attempt persists as the prose the learner saw, cut at the
      // same leak index (#140): the retry must not replay the JSON dump.
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.map((r) => r.kind)).toEqual([
        "user_message",
        "failed_assistant_response",
        "harness_retry_directive",
        "assistant_response",
      ]);
      expect(ctxRows[1]!.content).toBe("Here you go!");
      expect(ctxRows[2]!.content).toContain("raw JSON object");
      // The retry's rendered context replays that prose, never the dump.
      const replayed = streamedMessages.at(-1)!.filter((m) => m.role === "assistant");
      expect(replayed.at(-1)).toEqual({ role: "assistant", content: "Here you go!" });

      // chat_log carries only the successful attempt's prose.
      const wave = await getWaveById(waveId);
      const log = wave.chatLog as WaveChatLog;
      expect(log.at(-1)).toMatchObject({ role: "assistant", content: "Clean retry." });
    });
  });

  // -------------------------------------------------------------------------
  // 3c. Leak guard, mid-line and split across deltas (#156). One delta ends
  //     in `{`; the next opens its quoted key. The guard has no verdict on a
  //     trailing `{`, so the brace streams. No byte of the JSON body may.
  // -------------------------------------------------------------------------
  it("json-imitation attempt split mid-line across deltas: forwards at most the brace", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const jsonBody = '"questions": [{"id": "q1", "correct": "C"}]}';
      mockAgentAttempts(
        {
          parts: [textDelta("Here is your quiz: {"), textDelta(jsonBody)],
          steps: [
            {
              text: `Here is your quiz: {${jsonBody}`,
              toolCalls: [],
              toolResults: [],
              content: [],
            },
          ],
        },
        {
          parts: [textDelta("Clean retry.")],
          steps: [{ text: "Clean retry.", toolCalls: [], toolResults: [], content: [] }],
        },
      );
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

      // The first delta crossed whole, stray `{` included. The second
      // delta's cut index fell behind the forwarded text, so none of it did.
      const forwarded = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p["delta"] as string);
      expect(forwarded).toEqual(["Here is your quiz: {", "Clean retry."]);

      // The failed row is cut at the mid-line brace and trimmed (#140).
      const ctxRows = await getMessagesForWave(waveId);
      expect(ctxRows.map((r) => r.kind)).toEqual([
        "user_message",
        "failed_assistant_response",
        "harness_retry_directive",
        "assistant_response",
      ]);
      expect(ctxRows[1]!.content).toBe("Here is your quiz:");
    });
  });

  // -------------------------------------------------------------------------
  // 3d. Invalid quiz input (#169). The REAL SDK rejects a presentQuestionnaire
  //     call that fails the tool's superRefine. Its error message embeds the
  //     whole input as JSON, answer key and rubric included. Neither error
  //     chunk may carry that message to the client.
  // -------------------------------------------------------------------------
  it("invalid quiz input: tool error chunks carry no answer key or rubric", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      mockAgentModel(invalidQuizThenProseModel());
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

      // Guard the fixture: the SDK rejected the call, and both error chunks
      // reached the client with a non-empty errorText.
      const errorChunks = parts.filter(
        (p) => p.type === "tool-input-error" || p.type === "tool-output-error",
      );
      expect(errorChunks.map((p) => p.type)).toEqual(["tool-input-error", "tool-output-error"]);
      for (const chunk of errorChunks) {
        expect(chunk["errorText"]).toEqual(expect.stringMatching(/\S/));
      }
      expectNoQuizSecrets(parts);
    });
  });

  // -------------------------------------------------------------------------
  // 3e. Quiz execute throws (#169). A thrown error's message can carry the
  //     input. The tool-output-error chunk must not forward it.
  // -------------------------------------------------------------------------
  it("quiz tool-error: the tool-output-error chunk carries no answer key or rubric", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      const quizInput = {
        questions: [{ ...INVALID_QUIZ_INPUT.questions[0]!, conceptName: "ownership" }],
      };
      mockAgentAttempts({
        // The error rides the stream only; persistence reads `steps`.
        parts: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "presentQuestionnaire",
            input: quizInput,
          },
          {
            type: "tool-error",
            toolCallId: "c1",
            toolName: "presentQuestionnaire",
            input: quizInput,
            error: new Error(`execute failed on ${JSON.stringify(quizInput)}`),
          },
          textDelta("Let's keep going."),
        ],
        steps: [{ text: "Let's keep going.", toolCalls: [], toolResults: [], content: [] }],
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

      // Guard the fixture: the error chunk reached the client.
      expect(parts.filter((p) => p.type === "tool-output-error")).toHaveLength(1);
      expectNoQuizSecrets(parts);
    });
  });

  // -------------------------------------------------------------------------
  // 3f. Prompt cache key (#146). The Wave is the Context, so a mid-turn
  //     sends the wave id, not the course id or any other id.
  // -------------------------------------------------------------------------
  it("mid-turn: sends the wave id as the prompt cache key", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const proseStep: LanguageModelV3StreamPart[] = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Got it." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: STEP_USAGE },
      ];
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: simulateReadableStream({ chunks: proseStep }) }),
      });
      mockAgentModel(model);
      const { writer } = recordingWriter();

      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: { kind: "chat-text", text: "tell me about ownership" },
        },
        writer,
      );

      expect(model.doStreamCalls).toHaveLength(1);
      const sentKey = model.doStreamCalls[0]?.providerOptions?.["nalu-llm"]?.["prompt_cache_key"];
      expect(sentKey).toBe(waveId);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Close turn: a blocking `executeTurn` inside the stream. Result part
  //    only: no text parts, and the tool loop is never touched.
  // -------------------------------------------------------------------------
  it("close turn: emits only data-turn-result (kind close-turn), no text parts", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      // Seed WAVE.turnCount - 1 consumed learner turns so this submission is
      // the close turn.
      await seedPastChatTurns(waveId, WAVE.turnCount - 1);

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
      const agentBuildSpy = vi.spyOn(waveMidTurnAgentModule, "buildWaveMidTurnAgent");
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
      // The streaming agent loop is never touched on a close turn.
      expect(agentBuildSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Grading end to end: turn 1 presents a quiz, turn 2 answers it and the
  //    model records a signal. The harness grades the MC mechanically and
  //    awards XP on the assessment row.
  // -------------------------------------------------------------------------
  it("answered quiz: grades the MC correct and awards XP on the assessment row", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      const agentBuildSpy = mockAgentAttempts(
        toolCallAttempt(
          "presentQuestionnaire",
          QUIZ_INPUT,
          { accepted: true, questionCount: 1 },
          "Quiz below!",
        ),
        toolCallAttempt("recordComprehensionSignals", SIGNALS_INPUT, { recorded: 1 }, "Right!"),
      );

      // Turn 1: the quiz lands through production code (row + chat_log entry).
      const questionnaireId = await presentQuiz(courseId);

      // Turn 2: the learner picks the correct option.
      const second = recordingWriter();
      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: correctAnswerPayload(questionnaireId),
        },
        second.writer,
      );

      // Issue #144: the grading tool knows which ids this turn answered.
      // A chat turn binds none.
      expect(agentBuildSpy.mock.calls.map(([p]) => p.answeredQuestionIds)).toEqual([[], ["q1"]]);

      // The result part carries the grade's XP. It fails if grading is skipped.
      const resultPart = second.parts.at(-1)!;
      expect(resultPart.type).toBe("data-turn-result");
      const expectedXp = calculateMcXp(QUIZ_INPUT.questions[0]!.tier, true);
      expect(resultPart["data"]).toMatchObject({
        kind: "mid-turn",
        gradedSignals: [{ questionId: "q1", xpAwarded: expectedXp }],
      });
      // The assessment row holds the same grade, keyed on the namespaced id.
      const row = await getAssessmentByWaveAndQuestionId(
        waveId,
        namespaceQuestionId(questionnaireId, "q1"),
      );
      expect(row).toMatchObject({ isCorrect: true, xpAwarded: expectedXp, userAnswer: "A" });
    });
  });

  // -------------------------------------------------------------------------
  // 6. bug_001 retry, then grade: the first answers turn dies after the
  //    pre-LLM append. The identical retry must reuse that entry, still find
  //    the quiz open, and grade it.
  // -------------------------------------------------------------------------
  it("answered quiz after a failed attempt: retry grades once, one answers entry", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      mockAgentAttempts(
        toolCallAttempt(
          "presentQuestionnaire",
          QUIZ_INPUT,
          { accepted: true, questionCount: 1 },
          "Quiz below!",
        ),
        failingAttempt,
        toolCallAttempt("recordComprehensionSignals", SIGNALS_INPUT, { recorded: 1 }, "Right!"),
      );
      const questionnaireId = await presentQuiz(courseId);
      const params = {
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: correctAnswerPayload(questionnaireId),
      };

      // Attempt 1 dies after prepareWaveTurn appended the learner's answers.
      await expect(streamWaveTurn(params, recordingWriter().writer)).rejects.toThrow(
        "LLM transport failure",
      );

      // The identical retry grades the MC.
      const retry = recordingWriter();
      await streamWaveTurn(params, retry.writer);
      expect(retry.parts.at(-1)!["data"]).toMatchObject({
        kind: "mid-turn",
        gradedSignals: [{ questionId: "q1" }],
      });
      // The assessment row holds the grade, keyed on the namespaced id.
      const row = await getAssessmentByWaveAndQuestionId(
        waveId,
        namespaceQuestionId(questionnaireId, "q1"),
      );
      expect(row).toMatchObject({ isCorrect: true });
      // chat_log holds exactly one learner answers entry.
      const wave = await getWaveById(waveId);
      const answers = (wave.chatLog as WaveChatLog).filter(
        (e) => e.role === "user" && e.kind === "answers",
      );
      expect(answers).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 7. The mid-turn result carries the course total after its gradings. The
  //    course starts at PRIOR_XP, so a delta or a pre-grading read fails.
  // -------------------------------------------------------------------------
  it("answered quiz: the turn result's totalXp equals courses.total_xp", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      await incrementCourseXpInTx(courseId, PRIOR_XP, db);
      mockAgentAttempts(
        toolCallAttempt(
          "presentQuestionnaire",
          QUIZ_INPUT,
          { accepted: true, questionCount: 1 },
          "Quiz below!",
        ),
        toolCallAttempt("recordComprehensionSignals", SIGNALS_INPUT, { recorded: 1 }, "Right!"),
      );
      const questionnaireId = await presentQuiz(courseId);

      const { parts, writer } = recordingWriter();
      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: correctAnswerPayload(questionnaireId),
        },
        writer,
      );

      const totals = await readTotals(parts, courseId);
      expect(totals.fromResult).toBe(PRIOR_XP + QUIZ_MC_XP);
      expect(totals.fromResult).toBe(totals.fromDb);
    });
  });

  // -------------------------------------------------------------------------
  // 8. The close-turn result carries the total after the close grading AND
  //    the completion bump. The quiz lands on the last mid-turn, so the close
  //    grades its MC answer.
  // -------------------------------------------------------------------------
  it("close turn: totalXp includes the graded XP and completion XP", async () => {
    await withTestDb(async () => {
      const { courseId, waveId } = await seedCourseWithOpenWave();
      await incrementCourseXpInTx(courseId, PRIOR_XP, db);
      // Two turns short of the budget: the quiz turn, then the close turn.
      await seedPastChatTurns(waveId, WAVE.turnCount - 2);
      mockAgentAttempts(
        toolCallAttempt(
          "presentQuestionnaire",
          QUIZ_INPUT,
          { accepted: true, questionCount: 1 },
          "Quiz below!",
        ),
      );
      const questionnaireId = await presentQuiz(courseId);
      const closeParsed: WaveCloseTurn = {
        userMessage: "Closing chat.",
        summary: "We covered ownership.",
        gradings: [{ kind: "mc-index", questionId: "q1", rationale: "Knows let moves." }],
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

      const { parts, writer } = recordingWriter();
      await streamWaveTurn(
        {
          userId: USER_ID,
          courseId,
          waveNumber: 1,
          payload: correctAnswerPayload(questionnaireId),
        },
        writer,
      );

      expect(parts.at(-1)!["data"]).toMatchObject({ kind: "close-turn", nextWaveNumber: 2 });
      const totals = await readTotals(parts, courseId);
      expect(totals.fromResult).toBe(PRIOR_XP + QUIZ_MC_XP + WAVE.completionXp);
      expect(totals.fromResult).toBe(totals.fromDb);
    });
  });

  // -------------------------------------------------------------------------
  // 9. bug_001 retry: the failed attempt awards nothing, and the retry's
  //    total counts the answer's XP once.
  // -------------------------------------------------------------------------
  it("answered quiz after a failed attempt: totalXp counts the answer once", async () => {
    await withTestDb(async () => {
      const { courseId } = await seedCourseWithOpenWave();
      await incrementCourseXpInTx(courseId, PRIOR_XP, db);
      mockAgentAttempts(
        toolCallAttempt(
          "presentQuestionnaire",
          QUIZ_INPUT,
          { accepted: true, questionCount: 1 },
          "Quiz below!",
        ),
        failingAttempt,
        toolCallAttempt("recordComprehensionSignals", SIGNALS_INPUT, { recorded: 1 }, "Right!"),
      );
      const params = {
        userId: USER_ID,
        courseId,
        waveNumber: 1,
        payload: correctAnswerPayload(await presentQuiz(courseId)),
      };
      await expect(streamWaveTurn(params, recordingWriter().writer)).rejects.toThrow(
        "LLM transport failure",
      );

      const retry = recordingWriter();
      await streamWaveTurn(params, retry.writer);

      const totals = await readTotals(retry.parts, courseId);
      expect(totals.fromResult).toBe(PRIOR_XP + QUIZ_MC_XP);
      expect(totals.fromResult).toBe(totals.fromDb);
    });
  });
});
