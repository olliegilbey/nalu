import { describe, it, expect } from "vitest";
import { renderContext } from "./renderContext";
import type { ContextMessage } from "@/db/schema";
import type { LlmRenderedMessage } from "./renderContext";
import type { WaveSeedInputs } from "@/lib/types/context";

const SEED: WaveSeedInputs = {
  kind: "wave",
  courseTopic: "Rust ownership",
  topicScope: "Python → embedded",
  framework: {
    userMessage: "Here's the framework.",
    estimatedStartingTier: 2,
    baselineScopeTiers: [1, 2, 3],
    tiers: [
      { number: 1, name: "Mental Model", description: "...", exampleConcepts: ["move"] },
      { number: 2, name: "Borrowing", description: "...", exampleConcepts: ["&T"] },
    ],
  },
  currentTier: 2,
  customInstructions: null,
  courseSummary: null,
  dueConcepts: [],
  // scoping_handoff now carries the blueprint emitted by scoping's close turn.
  seedSource: {
    kind: "scoping_handoff",
    blueprint: {
      topic: "Rust ownership",
      outline: ["ownership"],
      openingText: "Welcome.",
      plannedConcepts: [],
    },
  },
};

const baseRow: Omit<ContextMessage, "id" | "createdAt"> = {
  waveId: "a0000000-0000-4000-8000-000000000001",
  scopingPassId: null,
  turnIndex: 0,
  seq: 0,
  kind: "user_message",
  role: "user",
  content: "<user_message>hi</user_message>",
};

const mkRow = (overrides: Partial<ContextMessage>): ContextMessage =>
  ({
    ...baseRow,
    id: "00000000-0000-0000-0000-000000000099",
    createdAt: new Date(0),
    ...overrides,
  }) as ContextMessage;

/**
 * Type-narrowing accessor for plain-content messages. Needed since
 * LlmRenderedMessage became a union (tool-calling migration): structured
 * variants carry no `content`, so `m?.content` no longer typechecks.
 * Behavioral assertions below are unchanged.
 */
const contentOf = (m: LlmRenderedMessage | undefined): string | undefined =>
  m !== undefined && "content" in m ? m.content : undefined;

describe("renderContext", () => {
  it("is byte-stable across calls", () => {
    const messages: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0, content: "<user_message>hi</user_message>" }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "harness_turn_counter",
        role: "user",
        content: "<turns_remaining>9 left</turns_remaining>",
      }),
      mkRow({
        turnIndex: 0,
        seq: 2,
        kind: "assistant_response",
        role: "assistant",
        content: "<response>welcome</response>",
      }),
    ];
    const a = renderContext(SEED, messages);
    const b = renderContext(SEED, messages);
    expect(a.system).toBe(b.system);
    expect(a.messages).toEqual(b.messages);
  });

  it("preserves prefix when a turn is appended", () => {
    const prefix: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0 }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "assistant_response",
        role: "assistant",
        content: "<response>r1</response>",
      }),
    ];
    const full: readonly ContextMessage[] = [
      ...prefix,
      mkRow({ turnIndex: 1, seq: 0, content: "<user_message>more</user_message>" }),
      mkRow({
        turnIndex: 1,
        seq: 1,
        kind: "assistant_response",
        role: "assistant",
        content: "<response>r2</response>",
      }),
    ];
    const a = renderContext(SEED, prefix);
    const b = renderContext(SEED, full);
    expect(b.system).toBe(a.system);
    a.messages.forEach((msg, i) => {
      expect(b.messages[i]).toEqual(msg);
    });
  });

  it("preserves prefix when card_answer rows are introduced", () => {
    const prefix: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0 }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "assistant_response",
        role: "assistant",
        content: '<response>here is a card</response>\n<assessment>{"questions":[]}</assessment>',
      }),
    ];
    const full: readonly ContextMessage[] = [
      ...prefix,
      mkRow({
        turnIndex: 1,
        seq: 0,
        kind: "card_answer",
        role: "user",
        content: "<card_answers>...</card_answers>",
      }),
    ];
    const a = renderContext(SEED, prefix);
    const b = renderContext(SEED, full);
    expect(b.system).toBe(a.system);
    a.messages.forEach((msg, i) => {
      expect(b.messages[i]).toEqual(msg);
    });
  });

  it("coalesces consecutive same-role rows into one message", () => {
    const messages: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0, content: "A" }),
      mkRow({ turnIndex: 0, seq: 1, kind: "harness_turn_counter", role: "user", content: "B" }),
    ];
    const r = renderContext(SEED, messages);
    expect(r.messages).toHaveLength(1);
    expect(contentOf(r.messages[0])).toBe("A\nB");
  });

  it("coalesces two consecutive user rows then emits the assistant row separately", () => {
    // Documents within-turn coalescing — locked so refactors must update both
    // the test and the TSDoc together (see renderContext.ts precondition block).
    const messages: readonly ContextMessage[] = [
      mkRow({
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "<user_message>hi</user_message>",
      }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "harness_turn_counter",
        role: "user",
        content: "<turns_remaining>9</turns_remaining>",
      }),
      mkRow({
        turnIndex: 0,
        seq: 2,
        kind: "assistant_response",
        role: "assistant",
        content: "<response>welcome</response>",
      }),
    ];
    const out = renderContext(SEED, messages);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]?.role).toBe("user");
    expect(contentOf(out.messages[0])).toBe(
      "<user_message>hi</user_message>\n<turns_remaining>9</turns_remaining>",
    );
    expect(out.messages[1]?.role).toBe("assistant");
  });

  it("handles a scoping seed and its messages", () => {
    const r = renderContext({ kind: "scoping", topic: "Rust ownership" }, [
      mkRow({
        waveId: null,
        scopingPassId: "a0000000-0000-4000-8000-000000000002",
        turnIndex: 0,
        seq: 0,
        content: "ask clarifying questions",
      }),
    ]);
    expect(r.system).toContain("<scoping_topic>Rust ownership</scoping_topic>");
    expect(r.messages).toHaveLength(1);
  });

  it("drops failed_assistant_response + harness_retry_directive when their turn ended in assistant_response", () => {
    const messages: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0, content: "u" }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "failed_assistant_response",
        role: "assistant",
        content: "bad",
      }),
      mkRow({
        turnIndex: 0,
        seq: 2,
        kind: "harness_retry_directive",
        role: "user",
        content: "directive",
      }),
      mkRow({
        turnIndex: 0,
        seq: 3,
        kind: "assistant_response",
        role: "assistant",
        content: "good",
      }),
    ];
    const r = renderContext(SEED, messages);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]?.role).toBe("user");
    expect(contentOf(r.messages[0])).toBe("u");
    expect(r.messages[1]?.role).toBe("assistant");
    expect(contentOf(r.messages[1])).toBe("good");
  });

  it("keeps every row in a terminal-exhaust turn (no assistant_response)", () => {
    const messages: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0, content: "u" }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "failed_assistant_response",
        role: "assistant",
        content: "fail-1",
      }),
      mkRow({
        turnIndex: 0,
        seq: 2,
        kind: "harness_retry_directive",
        role: "user",
        content: "directive-1",
      }),
      mkRow({
        turnIndex: 0,
        seq: 3,
        kind: "failed_assistant_response",
        role: "assistant",
        content: "fail-2",
      }),
    ];
    const r = renderContext(SEED, messages);
    // Roles alternate: user, assistant, user, assistant — no coalesce collapse.
    expect(r.messages).toHaveLength(4);
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("filter is per-turn: a recovered turn's filter does not affect a terminal-exhaust turn before it", () => {
    const messages: readonly ContextMessage[] = [
      // Turn 0: terminal exhaust — must be retained verbatim.
      mkRow({ turnIndex: 0, seq: 0, content: "u0" }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "failed_assistant_response",
        role: "assistant",
        content: "f0",
      }),
      mkRow({ turnIndex: 0, seq: 2, kind: "harness_retry_directive", role: "user", content: "d0" }),
      // Turn 1: retry-then-success — filtered.
      mkRow({ turnIndex: 1, seq: 0, content: "u1" }),
      mkRow({
        turnIndex: 1,
        seq: 1,
        kind: "failed_assistant_response",
        role: "assistant",
        content: "f1",
      }),
      mkRow({ turnIndex: 1, seq: 2, kind: "harness_retry_directive", role: "user", content: "d1" }),
      mkRow({ turnIndex: 1, seq: 3, kind: "assistant_response", role: "assistant", content: "ok" }),
    ];
    const r = renderContext(SEED, messages);
    // Turn 0 retained: u0(user), f0(asst), d0(user).
    // Turn 1 filtered: u1(user), ok(asst).
    // Row order after filter: u0, f0, d0, u1, ok.
    // Coalesce: d0+u1 → single user message with "\n" separator.
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(contentOf(r.messages[0])).toBe("u0");
    expect(contentOf(r.messages[1])).toBe("f0");
    expect(contentOf(r.messages[2])).toBe("d0\nu1");
    expect(contentOf(r.messages[3])).toBe("ok");
  });

  it("cache-prefix stability: appending a turn after a recovered retry leaves prior turns byte-identical", () => {
    const turn0Only: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0, content: "u0" }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "failed_assistant_response",
        role: "assistant",
        content: "f0",
      }),
      mkRow({ turnIndex: 0, seq: 2, kind: "harness_retry_directive", role: "user", content: "d0" }),
      mkRow({
        turnIndex: 0,
        seq: 3,
        kind: "assistant_response",
        role: "assistant",
        content: "ok0",
      }),
    ];
    const turn0AndTurn1: readonly ContextMessage[] = [
      ...turn0Only,
      mkRow({ turnIndex: 1, seq: 0, content: "u1" }),
      mkRow({
        turnIndex: 1,
        seq: 1,
        kind: "assistant_response",
        role: "assistant",
        content: "ok1",
      }),
    ];
    const a = renderContext(SEED, turn0Only);
    const b = renderContext(SEED, turn0AndTurn1);
    expect(b.system).toBe(a.system);
    expect(b.messages[0]).toEqual(a.messages[0]);
    expect(b.messages[1]).toEqual(a.messages[1]);
  });

  // ---------------------------------------------------------------------------
  // Tool-loop rows (tool-calling migration, 2026-06-10 plan)
  // ---------------------------------------------------------------------------

  it("renders an assistant_tool_call row as a structured tool-call message and tool_result as a tool message", () => {
    const rows: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0, content: "hi" }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "assistant_tool_call",
        role: "assistant",
        content: JSON.stringify({
          text: "Let me check that.",
          toolCalls: [
            { toolCallId: "c1", toolName: "presentQuestionnaire", input: { questions: [] } },
          ],
        }),
      }),
      mkRow({
        turnIndex: 0,
        seq: 2,
        kind: "tool_result",
        role: "tool",
        content: JSON.stringify({
          results: [
            { toolCallId: "c1", toolName: "presentQuestionnaire", output: { accepted: true } },
          ],
        }),
      }),
      mkRow({
        turnIndex: 0,
        seq: 3,
        kind: "assistant_response",
        role: "assistant",
        content: "Here's your quiz.",
      }),
    ];
    const rendered = renderContext(SEED, rows);
    expect(rendered.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const toolCallMsg = rendered.messages[1];
    if (!(toolCallMsg && "kind" in toolCallMsg && toolCallMsg.kind === "tool-call")) {
      throw new Error("expected structured tool-call message at index 1");
    }
    expect(toolCallMsg.text).toBe("Let me check that.");
    expect(toolCallMsg.toolCalls).toEqual([
      { toolCallId: "c1", toolName: "presentQuestionnaire", input: { questions: [] } },
    ]);

    const toolResultMsg = rendered.messages[2];
    if (!(toolResultMsg && "results" in toolResultMsg)) {
      throw new Error("expected structured tool-result message at index 2");
    }
    expect(toolResultMsg.results).toEqual([
      { toolCallId: "c1", toolName: "presentQuestionnaire", output: { accepted: true } },
    ]);
  });

  it("does not coalesce a plain assistant row into a structured tool-call row", () => {
    // assistant_tool_call (assistant role) immediately followed by
    // assistant_response (assistant role): same-role coalescing must NOT
    // merge them — the structured message is a distinct API message.
    const rows: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0, content: "hi" }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "assistant_tool_call",
        role: "assistant",
        content: JSON.stringify({
          text: "",
          toolCalls: [{ toolCallId: "c1", toolName: "t", input: {} }],
        }),
      }),
      mkRow({
        turnIndex: 0,
        seq: 2,
        kind: "assistant_response",
        role: "assistant",
        content: "closing prose",
      }),
    ];
    const rendered = renderContext(SEED, rows);
    expect(rendered.messages).toHaveLength(3);
    expect(rendered.messages[2]).toEqual({ role: "assistant", content: "closing prose" });
  });

  it("tool rows preserve cache-prefix byte stability when later rows append", () => {
    const prefix: readonly ContextMessage[] = [
      mkRow({ turnIndex: 0, seq: 0, content: "hi" }),
      mkRow({
        turnIndex: 0,
        seq: 1,
        kind: "assistant_tool_call",
        role: "assistant",
        content: JSON.stringify({
          text: "checking",
          toolCalls: [{ toolCallId: "c1", toolName: "t", input: { a: 1 } }],
        }),
      }),
      mkRow({
        turnIndex: 0,
        seq: 2,
        kind: "tool_result",
        role: "tool",
        content: JSON.stringify({
          results: [{ toolCallId: "c1", toolName: "t", output: { ok: true } }],
        }),
      }),
      mkRow({
        turnIndex: 0,
        seq: 3,
        kind: "assistant_response",
        role: "assistant",
        content: "done",
      }),
    ];
    const appended: readonly ContextMessage[] = [
      ...prefix,
      mkRow({ turnIndex: 1, seq: 0, content: "next turn" }),
    ];
    const before = renderContext(SEED, prefix);
    const after = renderContext(SEED, appended);
    // Every message rendered from the prefix is byte-identical after the append.
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  });

  it("throws on a corrupt assistant_tool_call row (trust boundary)", () => {
    const rows: readonly ContextMessage[] = [
      mkRow({
        turnIndex: 0,
        seq: 0,
        kind: "assistant_tool_call",
        role: "assistant",
        content: "not json",
      }),
    ];
    expect(() => renderContext(SEED, rows)).toThrow(/assistant_tool_call/);
  });
});
