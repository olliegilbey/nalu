import { describe, it, expect } from "vitest";
import { deriveSendAction, type SendControls } from "./deriveSendAction";

/** An answer card with typed text, ready to send. */
const typed = (inputValue: string, overrides: Partial<SendControls> = {}): SendControls => ({
  hasQuestions: true,
  inputValue,
  confirmMode: false,
  canSend: true,
  ...overrides,
});

describe("deriveSendAction", () => {
  it("ignores Send while disabled, even with a pick to confirm", () => {
    const controls = typed("", { confirmMode: true, canSend: false });
    expect(deriveSendAction(controls, true)).toEqual({ kind: "ignore" });
  });

  it("confirms the pending pick in confirm mode", () => {
    const controls = typed("", { confirmMode: true, canSend: false });
    expect(deriveSendAction(controls, false)).toEqual({ kind: "confirm" });
  });

  it("ignores Send with nothing to send", () => {
    expect(deriveSendAction(typed("", { canSend: false }), false)).toEqual({ kind: "ignore" });
  });

  it("sends a chat message without a card", () => {
    const controls = typed("hello", { hasQuestions: false });
    expect(deriveSendAction(controls, false)).toEqual({ kind: "chat" });
  });

  it("answers with the trimmed text", () => {
    expect(deriveSendAction(typed("  Paris  "), false)).toEqual({
      kind: "answer",
      answer: "Paris",
    });
  });
});
