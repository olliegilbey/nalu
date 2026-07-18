import { describe, it, expect } from "vitest";
import { adaptQuestionnaire, adaptOpenQuestion } from "./adaptQuestionnaire";
import type { Question } from "@/lib/prompts/questionnaire";

describe("adaptQuestionnaire", () => {
  it("adapts MC questions and derives correctIndex from `correct` letter key", () => {
    const qs: readonly Question[] = [
      {
        id: "b1",
        type: "multiple_choice",
        prompt: "What is 2+2?",
        options: { A: "3", B: "4", C: "5", D: "6" },
        correct: "B",
        freetextRubric: "n/a",
        conceptName: "addition",
        tier: 1,
      },
    ];
    const result = adaptQuestionnaire(qs);
    expect(result.mode).toBe("mc");
    expect(result.questions).toEqual([
      {
        id: "b1",
        prompt: "What is 2+2?",
        options: ["3", "4", "5", "6"],
        correctIndex: 1,
        tier: 1,
      },
    ]);
  });

  it("carries the optional tier through for MC and free-text questions", () => {
    const qs: readonly Question[] = [
      {
        id: "m1",
        type: "multiple_choice",
        prompt: "p",
        options: { A: "1", B: "2", C: "3", D: "4" },
        correct: "A",
        freetextRubric: "n/a",
        conceptName: "c",
        tier: 3,
      },
      {
        id: "f1",
        type: "free_text",
        prompt: "p2",
        freetextRubric: "n/a",
        conceptName: "c2",
        tier: 4,
      },
    ];
    const r = adaptQuestionnaire(qs);
    expect(r.questions[0]!.tier).toBe(3);
    expect(r.questions[1]!.tier).toBe(4);
  });

  it("leaves correctIndex undefined when `correct` is absent (clarify-style MC)", () => {
    const qs: readonly Question[] = [
      {
        id: "c1",
        type: "multiple_choice",
        prompt: "Pick one",
        options: { A: "a", B: "b", C: "c", D: "d" },
        freetextRubric: "n/a",
      },
    ];
    const r = adaptQuestionnaire(qs);

    expect(r.questions[0]!.correctIndex).toBeUndefined();
  });

  it("adapts free-text questions to ChoiceQuestion with empty options array", () => {
    const qs: readonly Question[] = [
      {
        id: "f1",
        type: "free_text",
        prompt: "Why are you learning?",
        freetextRubric: "n/a",
      },
    ];
    const r = adaptQuestionnaire(qs);
    expect(r.mode).toBe("free-text");
    expect(r.questions).toEqual([{ id: "f1", prompt: "Why are you learning?", options: [] }]);
  });

  it("adaptOpenQuestion carries the optional tier through", () => {
    const adapted = adaptOpenQuestion({
      id: "q1",
      type: "multiple_choice",
      prompt: "?",
      options: { A: "1", B: "2", C: "3", D: "4" },
      correctEnc: "unused",
      tier: 2,
    });
    expect(adapted.tier).toBe(2);
  });

  it("classifies mode as 'mc' only when every question has options", () => {
    const qs: readonly Question[] = [
      {
        id: "m1",
        type: "multiple_choice",
        prompt: "p",
        options: { A: "1", B: "2", C: "3", D: "4" },
        freetextRubric: "n/a",
      },
      {
        id: "m2",
        type: "free_text",
        prompt: "p2",
        freetextRubric: "n/a",
      },
    ];
    const r = adaptQuestionnaire(qs);
    expect(r.mode).toBe("mixed");
  });
});
