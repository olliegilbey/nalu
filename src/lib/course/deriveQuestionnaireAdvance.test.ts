import { describe, it, expect } from "vitest";
import { deriveQuestionnaireAdvance } from "./deriveQuestionnaireAdvance";
import type { ChoiceQuestion } from "./adaptQuestionnaire";

const mc = (id: string): ChoiceQuestion => ({
  id,
  prompt: `MC ${id}`,
  options: ["Yes", "No", "Maybe", "Never"],
  correctIndex: 0,
});
const freeText = (id: string): ChoiceQuestion => ({ id, prompt: `Free ${id}`, options: [] });

const three = [mc("q1"), mc("q2"), mc("q3")];

describe("deriveQuestionnaireAdvance", () => {
  it("records the answer without mutating the input answers", () => {
    const answers = [null, null, null];
    const advance = deriveQuestionnaireAdvance({
      questions: three,
      answers,
      drafts: ["", "", ""],
      questionIndex: 0,
      answer: "Yes",
    });
    expect(advance.answers).toEqual(["Yes", null, null]);
    expect(answers).toEqual([null, null, null]);
  });

  it("moves to the following question", () => {
    const advance = deriveQuestionnaireAdvance({
      questions: three,
      answers: [null, null, null],
      drafts: ["", "", ""],
      questionIndex: 0,
      answer: "Yes",
    });
    expect(advance).toEqual({ kind: "advance", answers: ["Yes", null, null], nextIndex: 1 });
  });

  it("moves to the following question even when it is already answered", () => {
    // The learner skipped q1, answered q2, then went back. Answering q1 steps
    // forward onto q2's locked answer, not to the gap at q3.
    const advance = deriveQuestionnaireAdvance({
      questions: three,
      answers: [null, "No", null],
      drafts: ["", "", ""],
      questionIndex: 0,
      answer: "Yes",
    });
    expect(advance).toEqual({ kind: "advance", answers: ["Yes", "No", null], nextIndex: 1 });
  });

  it("wraps from the last question to the first unanswered one", () => {
    const advance = deriveQuestionnaireAdvance({
      questions: three,
      answers: ["Yes", null, null],
      drafts: ["", "", ""],
      questionIndex: 2,
      answer: "Maybe",
    });
    expect(advance).toEqual({ kind: "advance", answers: ["Yes", null, "Maybe"], nextIndex: 1 });
  });

  it("completes once every question has an answer, pairing each with its question", () => {
    const advance = deriveQuestionnaireAdvance({
      questions: three,
      answers: ["Yes", null, "Maybe"],
      drafts: ["", "", ""],
      questionIndex: 1,
      answer: "No",
    });
    expect(advance).toEqual({
      kind: "complete",
      answers: ["Yes", "No", "Maybe"],
      completed: [
        { question: three[0], answer: "Yes" },
        { question: three[1], answer: "No" },
        { question: three[2], answer: "Maybe" },
      ],
    });
  });

  it("completes a free-text question with its trimmed live draft, picking up back-edits", () => {
    const questions = [freeText("q1"), mc("q2")];
    const advance = deriveQuestionnaireAdvance({
      questions,
      // q1 was sent as "first try", then edited on revisit.
      answers: ["first try", null],
      drafts: ["  edited answer  ", ""],
      questionIndex: 1,
      answer: "No",
    });
    expect(advance.kind).toBe("complete");
    expect(advance.kind === "complete" && advance.completed[0]?.answer).toBe("edited answer");
  });

  it("falls back to the recorded free-text answer when the draft was blanked", () => {
    const questions = [freeText("q1"), mc("q2")];
    const advance = deriveQuestionnaireAdvance({
      questions,
      answers: ["first try", null],
      drafts: ["   ", ""],
      questionIndex: 1,
      answer: "No",
    });
    expect(advance.kind === "complete" && advance.completed[0]?.answer).toBe("first try");
  });

  it("completes an MC question with its recorded option text, ignoring any draft", () => {
    const questions = [mc("q1")];
    const advance = deriveQuestionnaireAdvance({
      questions,
      answers: [null],
      drafts: ["stray draft"],
      questionIndex: 0,
      answer: "Yes",
    });
    expect(advance.kind === "complete" && advance.completed[0]?.answer).toBe("Yes");
  });
});
