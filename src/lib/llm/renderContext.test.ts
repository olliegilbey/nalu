import { describe, it, expect } from "vitest";
import { renderContext } from "./renderContext";
import type { ContextMessage } from "@/db/schema";
import type { WaveSeedInputs } from "@/lib/types/context";

const SEED: WaveSeedInputs = {
  kind: "wave",
  courseTopic: "Rust ownership",
  topicScope: "Python → embedded",
  framework: {
    topic: "Rust ownership",
    scope_summary: "x",
    estimated_starting_tier: 2,
    baseline_scope_tiers: [1, 2, 3],
    tiers: [
      { number: 1, name: "Mental Model", description: "...", example_concepts: ["move"] },
      { number: 2, name: "Borrowing", description: "...", example_concepts: ["&T"] },
    ],
  },
  currentTier: 2,
  customInstructions: null,
  courseSummary: null,
  dueConcepts: [],
  seedSource: { kind: "scoping_handoff" },
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
    expect(r.messages[0]?.content).toBe("A\nB");
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
    expect(out.messages[0]?.content).toBe(
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
    expect(r.messages[0]?.content).toBe("u");
    expect(r.messages[1]?.role).toBe("assistant");
    expect(r.messages[1]?.content).toBe("good");
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
    expect(r.messages[0]?.content).toBe("u0");
    expect(r.messages[1]?.content).toBe("f0");
    expect(r.messages[2]?.content).toBe("d0\nu1");
    expect(r.messages[3]?.content).toBe("ok");
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
});
