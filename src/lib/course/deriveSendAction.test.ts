import { describe, it, expect } from "vitest";
import { deriveSendAction, type SendControls } from "./deriveSendAction";
import type { ChoiceQuestion } from "./adaptQuestionnaire";

const capital: ChoiceQuestion = {
  id: "q1",
  prompt: "Capital of France?",
  options: ["Paris", "Lyon", "Nice", "Lille"],
  correctIndex: 0,
  tier: 2,
};
const freeQuestion: ChoiceQuestion = { id: "q2", prompt: "Why?", options: [] };

/** An answer card on `capital` with typed text, ready to send. */
const typed = (inputValue: string, overrides: Partial<SendControls> = {}): SendControls => ({
  hasQuestions: true,
  current: capital,
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
    const controls = typed("hello", { hasQuestions: false, current: null });
    expect(deriveSendAction(controls, false)).toEqual({ kind: "chat" });
  });

  it("answers with the trimmed text, earning MC XP for the correct option typed verbatim", () => {
    expect(deriveSendAction(typed("  Paris  "), false)).toEqual({
      kind: "answer",
      answer: "Paris",
      earnsMcXpFor: capital,
    });
  });

  // "Lyon" names a wrong option. "paris" is not verbatim, so it ships as free text.
  it.each(["Lyon", "paris"])("answers %s without MC XP", (text) => {
    expect(deriveSendAction(typed(text), false)).toEqual({
      kind: "answer",
      answer: text,
      earnsMcXpFor: null,
    });
  });

  it("answers a free-text question without MC XP", () => {
    const controls = typed("Because", { current: freeQuestion });
    expect(deriveSendAction(controls, false)).toEqual({
      kind: "answer",
      answer: "Because",
      earnsMcXpFor: null,
    });
  });
});
