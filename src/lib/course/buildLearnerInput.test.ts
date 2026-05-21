import { describe, expect, it } from "vitest";
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
