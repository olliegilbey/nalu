import { describe, expect, it } from "vitest";
import { typedMcGradingRule } from "@/lib/prompts/questionnaire";
import { renderWaveCloseEnvelope } from "@/lib/prompts/waveClose";
import { renderWaveTurnEnvelope } from "@/lib/prompts/waveTurn";
import { buildLearnerInput } from "./buildLearnerInput";

describe("buildLearnerInput", () => {
  it("wraps chat-text in <learner_reply> with XML-escaped content", () => {
    const out = buildLearnerInput({ kind: "chat-text", text: "hello <world>" }, null);
    expect(out).toContain("<learner_reply>");
    expect(out).toContain("hello &lt;world&gt;");
    expect(out).toContain("</learner_reply>");
  });

  it("renders per-answer questionnaire_answer blocks for MC and free-text", () => {
    const out = buildLearnerInput(
      {
        kind: "questionnaire-answers",
        questionnaireId: "qn1",
        answers: [
          { id: "q1", kind: "mc", selected: "B" },
          { id: "q2", kind: "freetext", text: "demand slopes down", fromEscape: false },
        ],
      },
      {
        questionnaireId: "qn1",
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "?",
            options: { A: "A", B: "B", C: "C", D: "D" },
            correct: "B",
            freetextRubric: "rubric",
          },
          { id: "q2", type: "free_text", prompt: "Why?", freetextRubric: "rubric" },
        ],
      },
    );
    expect(out).toContain('kind="mc-index"');
    expect(out).toContain("selected_index=1"); // B = 1
    expect(out).toContain('verdict="correct"');
    expect(out).toContain('kind="free-text"');
    expect(out).toContain("demand slopes down");
  });

  it("marks MC-escape free-text answers with fromEscape", () => {
    const out = buildLearnerInput(
      {
        kind: "questionnaire-answers",
        questionnaireId: "qn1",
        answers: [{ id: "q1", kind: "freetext", text: "uncertain", fromEscape: true }],
      },
      {
        questionnaireId: "qn1",
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "?",
            options: { A: "A", B: "B", C: "C", D: "D" },
            correct: "B",
            freetextRubric: "rubric",
          },
        ],
      },
    );
    expect(out).toContain('fromEscape="true"');
  });
});

// Issue #149: a typed answer to an MC question is graded as free text. Its
// rubric is unchecked, so the Harness hands the grader the options and the key.
describe("buildLearnerInput — typed MC answers (issue #149)", () => {
  const MC_RECORD = {
    questionnaireId: "qn1",
    questions: [
      {
        id: "q1",
        type: "multiple_choice" as const,
        prompt: "Where does a Box live?",
        options: { A: "Stack", B: "Heap <alloc>", C: "Register", D: "Disk" },
        correct: "B" as const,
        freetextRubric: "no grading",
      },
      { id: "q2", type: "free_text" as const, prompt: "Why?", freetextRubric: "rubric" },
    ],
  };

  const typed = (text: string) =>
    buildLearnerInput(
      {
        kind: "questionnaire-answers",
        questionnaireId: "qn1",
        answers: [{ id: "q1", kind: "freetext", text, fromEscape: true }],
      },
      MC_RECORD,
    );

  it("gives the grader the four options, the correct key and the grading rule", () => {
    const out = typed("on the heap");
    expect(out).toContain('<mc_answer_key correct="B">');
    expect(out).toContain("A: Stack");
    expect(out).toContain("B: Heap");
    expect(out).toContain("C: Register");
    expect(out).toContain("D: Disk");
    expect(out).toContain(typedMcGradingRule("B"));
    expect(out).toContain("</mc_answer_key>");
  });

  // The question type is server truth; `fromEscape` is client-reported. These
  // two cases fail if the gate reads `fromEscape` instead.
  it("keys an MC question answered in text even when fromEscape is false", () => {
    const out = buildLearnerInput(
      {
        kind: "questionnaire-answers",
        questionnaireId: "qn1",
        answers: [{ id: "q1", kind: "freetext", text: "on the heap", fromEscape: false }],
      },
      MC_RECORD,
    );
    expect(out).toContain('<mc_answer_key correct="B">');
  });

  it("gives a free-text question no key, and does not throw, even when fromEscape is true", () => {
    const out = buildLearnerInput(
      {
        kind: "questionnaire-answers",
        questionnaireId: "qn1",
        answers: [{ id: "q2", kind: "freetext", text: "demand slopes down", fromEscape: true }],
      },
      MC_RECORD,
    );
    expect(out).not.toContain("mc_answer_key");
  });

  it("escapes the model-authored options and the learner's text", () => {
    const out = typed("<b>heap</b>");
    expect(out).toContain("B: Heap &lt;alloc&gt;");
    expect(out).toContain("<user_message>&lt;b&gt;heap&lt;/b&gt;</user_message>");
    expect(out).not.toContain("<alloc>");
    expect(out).not.toContain("<b>");
  });

  it("reaches both Wave grader envelopes: the mid-turn and the close turn", () => {
    const learnerInput = typed("on the heap");
    const mid = renderWaveTurnEnvelope({ learnerInput, turnsRemaining: 2 });
    const close = renderWaveCloseEnvelope({ learnerInput, conceptsForNextWaveBlock: "" });
    for (const envelope of [mid, close]) {
      expect(envelope).toContain('<mc_answer_key correct="B">');
      expect(envelope).toContain(typedMcGradingRule("B"));
    }
  });

  it("leaves a clicked MC answer mechanical, with no answer-key block", () => {
    const out = buildLearnerInput(
      {
        kind: "questionnaire-answers",
        questionnaireId: "qn1",
        answers: [{ id: "q1", kind: "mc", selected: "B" }],
      },
      MC_RECORD,
    );
    expect(out).toBe(
      [
        '<questionnaire_answers questionnaireId="qn1">',
        '<questionnaire_answer kind="mc-index" questionId="q1" selected_index=1 correct_index=1 verdict="correct"/>',
        "</questionnaire_answers>",
      ].join("\n"),
    );
  });

  it("leaves a native free-text answer unchanged", () => {
    const out = buildLearnerInput(
      {
        kind: "questionnaire-answers",
        questionnaireId: "qn1",
        answers: [{ id: "q2", kind: "freetext", text: "demand slopes down", fromEscape: false }],
      },
      MC_RECORD,
    );
    expect(out).toBe(
      [
        '<questionnaire_answers questionnaireId="qn1">',
        '<questionnaire_answer kind="free-text" questionId="q2" fromEscape="false">',
        "<user_message>demand slopes down</user_message>",
        "</questionnaire_answer>",
        "</questionnaire_answers>",
      ].join("\n"),
    );
  });
});
