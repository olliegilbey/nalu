import { describe, it, expect } from "vitest";
import { deriveComposerControls, type ComposerControlsInput } from "./deriveComposerControls";
import type { ChoiceQuestion } from "./adaptQuestionnaire";

const mcQuestion: ChoiceQuestion = {
  id: "q1",
  prompt: "Capital of France?",
  options: ["Paris", "Lyon", "Nice", "Lille"],
  correctIndex: 0,
};
const freeQuestion: ChoiceQuestion = { id: "q2", prompt: "Why?", options: [] };

/** A live two-question card on its first question, nothing picked or typed. */
const card = (overrides: Partial<ComposerControlsInput> = {}): ComposerControlsInput => ({
  questions: [mcQuestion, freeQuestion],
  questionIndex: 0,
  answers: [null, null],
  pending: [null, null],
  inputValue: "",
  disabled: false,
  persistKey: "nalu:test:card",
  ...overrides,
});

/** The plain chat input: no questions. */
const chat = (overrides: Partial<ComposerControlsInput> = {}): ComposerControlsInput =>
  card({ questions: null, answers: [], pending: [], ...overrides });

describe("deriveComposerControls", () => {
  it("chat mode: no card, nothing locked, send follows the input", () => {
    expect(deriveComposerControls(chat({ inputValue: "hello" }))).toEqual({
      hasQuestions: false,
      current: null,
      total: 0,
      currentPending: null,
      answerLocked: false,
      confirmMode: false,
      canSend: true,
      textareaLocked: false,
      isPreview: false,
      canGoPrev: false,
      canGoNext: false,
    });
  });

  it("chat mode: treats an empty question list as no card", () => {
    expect(deriveComposerControls(chat({ questions: [] })).hasQuestions).toBe(false);
  });

  it("chat mode: ignores answers and picks left over from the last card", () => {
    const controls = deriveComposerControls(chat({ answers: ["Paris"], pending: [0] }));
    expect(controls.answerLocked).toBe(false);
    expect(controls.currentPending).toBeNull();
    expect(controls.confirmMode).toBe(false);
  });

  it.each([
    ["blank input", { inputValue: "   " }],
    ["disabled", { inputValue: "hello", disabled: true }],
  ])("cannot send with %s", (_label, overrides) => {
    expect(deriveComposerControls(chat(overrides)).canSend).toBe(false);
  });

  it("card mode: exposes the current question and the total", () => {
    const controls = deriveComposerControls(card({ questionIndex: 1 }));
    expect(controls.hasQuestions).toBe(true);
    expect(controls.current).toBe(freeQuestion);
    expect(controls.total).toBe(2);
  });

  it("confirm mode: an unconfirmed pick with an empty input", () => {
    const controls = deriveComposerControls(card({ pending: [2, null] }));
    expect(controls.currentPending).toBe(2);
    expect(controls.confirmMode).toBe(true);
  });

  it("leaves confirm mode once the learner types", () => {
    expect(
      deriveComposerControls(card({ pending: [2, null], inputValue: "Nice" })).confirmMode,
    ).toBe(false);
  });

  it("locks a recorded MC answer: no confirm, textarea locked", () => {
    const controls = deriveComposerControls(card({ answers: ["Nice", null], pending: [2, null] }));
    expect(controls.answerLocked).toBe(true);
    expect(controls.confirmMode).toBe(false);
    expect(controls.textareaLocked).toBe(true);
  });

  it("keeps a recorded free-text answer editable", () => {
    const controls = deriveComposerControls(
      card({ questionIndex: 1, answers: [null, "Because"], inputValue: "Because" }),
    );
    expect(controls.answerLocked).toBe(true);
    expect(controls.textareaLocked).toBe(false);
  });

  it("marks a card without a buffer key as a read-only preview", () => {
    expect(deriveComposerControls(card({ persistKey: undefined })).isPreview).toBe(true);
    expect(deriveComposerControls(card()).isPreview).toBe(false);
  });

  it("bounds prev and next navigation to the card", () => {
    const first = deriveComposerControls(card({ questionIndex: 0 }));
    expect([first.canGoPrev, first.canGoNext]).toEqual([false, true]);
    const last = deriveComposerControls(card({ questionIndex: 1 }));
    expect([last.canGoPrev, last.canGoNext]).toEqual([true, false]);
  });
});
