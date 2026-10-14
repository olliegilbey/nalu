import { describe, expect, it } from "vitest";
import { typedMcGradingRule } from "@/lib/prompts/questionnaire";
import { renderScopingCloseStage } from "@/lib/prompts/scopingClose";
import { buildScopingCloseLearnerInput, gradeMc } from "./submitBaseline.internal";

// Issue #149: a typed answer to a baseline MC question goes to the close-turn
// grader as free text. Its rubric is unchecked, so the Harness attaches the
// options and the correct key.
describe("buildScopingCloseLearnerInput", () => {
  const MC = {
    id: "b1",
    type: "multiple_choice" as const,
    prompt: "Where does a Box live?",
    options: { A: "Stack", B: "Heap <alloc>", C: "Register", D: "Disk" },
    correct: "B" as const,
    freetextRubric: "no grading",
    conceptName: "box",
    tier: 1,
  };
  const FREE_TEXT = {
    id: "b2",
    type: "free_text" as const,
    prompt: "What is ownership?",
    freetextRubric: "Names the single-owner rule for every value.",
    conceptName: "ownership",
    tier: 1,
  };
  const QUESTIONS = [MC, FREE_TEXT];

  /** Parse the JSON payload back so each answer can be read by id. */
  const answersOf = (learnerInput: string) =>
    (JSON.parse(learnerInput) as { answers: Record<string, unknown>[] }).answers;

  it("gives a typed MC answer the four options, the correct key and the grading rule", () => {
    const learnerInput = buildScopingCloseLearnerInput({
      questions: QUESTIONS,
      answers: [{ id: "b1", kind: "freetext", text: "on the heap", fromEscape: true }],
      mechanicalGradings: [],
    });
    expect(answersOf(learnerInput)).toEqual([
      {
        id: "b1",
        kind: "freetext",
        text: "on the heap",
        fromEscape: true,
        mcAnswerKey: { correct: "B", options: MC.options, gradingRule: typedMcGradingRule("B") },
      },
    ]);
  });

  // The question type is server truth; `fromEscape` is client-reported. These
  // two cases fail if the gate reads `fromEscape` instead.
  it("keys an MC question answered in text even when fromEscape is false", () => {
    const learnerInput = buildScopingCloseLearnerInput({
      questions: QUESTIONS,
      answers: [{ id: "b1", kind: "freetext", text: "on the heap", fromEscape: false }],
      mechanicalGradings: [],
    });
    expect(answersOf(learnerInput)[0]).toHaveProperty("mcAnswerKey.correct", "B");
  });

  it("gives a free-text question no key, and does not throw, even when fromEscape is true", () => {
    const answers = [
      { id: "b2", kind: "freetext", text: "one owner per value", fromEscape: true },
    ] as const;
    const learnerInput = buildScopingCloseLearnerInput({
      questions: QUESTIONS,
      answers,
      mechanicalGradings: [],
    });
    expect(answersOf(learnerInput)).toEqual(answers);
  });

  it("escapes the options and the learner's text in the close envelope", () => {
    const envelope = renderScopingCloseStage({
      learnerInput: buildScopingCloseLearnerInput({
        questions: QUESTIONS,
        answers: [{ id: "b1", kind: "freetext", text: "<b>heap</b>", fromEscape: true }],
        mechanicalGradings: [],
      }),
    });
    expect(envelope).toContain("Heap &lt;alloc&gt;");
    expect(envelope).toContain("&lt;b&gt;heap&lt;/b&gt;");
    expect(envelope).not.toContain("<alloc>");
    expect(envelope).not.toContain("<b>");
  });

  it("leaves a clicked MC answer and a native free-text answer unchanged", () => {
    const answers = [
      { id: "b1", kind: "mc", selected: "B" },
      { id: "b2", kind: "freetext", text: "one owner per value", fromEscape: false },
    ] as const;
    const mechanicalGradings = [gradeMc(MC, "B")];
    const learnerInput = buildScopingCloseLearnerInput({
      questions: QUESTIONS,
      answers,
      mechanicalGradings,
    });
    expect(learnerInput).toBe(JSON.stringify({ answers, mechanicalGradings }));
  });
});
