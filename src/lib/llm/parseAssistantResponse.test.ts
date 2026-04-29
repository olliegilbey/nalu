import { describe, it, expect } from "vitest";
import { parseAssistantResponse, ValidationGateFailure } from "./parseAssistantResponse";

describe("parseAssistantResponse", () => {
  it("extracts <response> on a regular turn", () => {
    const r = parseAssistantResponse("<response>hello world</response>", {
      requireFinalTurnTags: false,
    });
    expect(r.response).toBe("hello world");
    expect(r.comprehensionSignals).toEqual([]);
    expect(r.assessment).toBeNull();
  });

  it("throws ValidationGateFailure when <response> is missing", () => {
    expect(() =>
      parseAssistantResponse("<assessment>{}</assessment>", { requireFinalTurnTags: false }),
    ).toThrow(ValidationGateFailure);
  });

  it("drops a malformed <comprehension_signal> silently", () => {
    const r = parseAssistantResponse(
      `<response>r</response>\n<comprehension_signal>{"concept_name":"x","tier":2,"demonstrated_quality":99,"evidence":"e"}</comprehension_signal>`,
      { requireFinalTurnTags: false },
    );
    expect(r.comprehensionSignals).toEqual([]);
  });

  it("extracts a valid <comprehension_signal>", () => {
    const r = parseAssistantResponse(
      `<response>r</response>\n<comprehension_signal>{"concept_name":"x","tier":2,"demonstrated_quality":4,"evidence":"e"}</comprehension_signal>`,
      { requireFinalTurnTags: false },
    );
    expect(r.comprehensionSignals).toHaveLength(1);
    expect(r.comprehensionSignals[0]?.concept_name).toBe("x");
  });

  it("extracts an assessment card", () => {
    const card = {
      questions: [
        {
          question_id: "q1",
          concept_name: "c",
          tier: 1,
          type: "multiple_choice",
          question: "?",
          options: { A: "a", B: "b" },
          correct: "A",
        },
      ],
    };
    const r = parseAssistantResponse(
      `<response>r</response>\n<assessment>${JSON.stringify(card)}</assessment>`,
      { requireFinalTurnTags: false },
    );
    expect(r.assessment?.questions[0]?.question_id).toBe("q1");
  });

  it("requires both final-turn tags when requireFinalTurnTags=true", () => {
    expect(() =>
      parseAssistantResponse("<response>r</response>", { requireFinalTurnTags: true }),
    ).toThrow(ValidationGateFailure);
  });

  it("accepts both final-turn tags on a final turn", () => {
    const blueprint = { topic: "next", outline: ["a"], openingText: "hi" };
    const summary = { summary: "ok" };
    const r = parseAssistantResponse(
      `<response>r</response>\n<next_lesson_blueprint>${JSON.stringify(
        blueprint,
      )}</next_lesson_blueprint>\n<course_summary_update>${JSON.stringify(summary)}</course_summary_update>`,
      { requireFinalTurnTags: true },
    );
    expect(r.nextLessonBlueprint?.topic).toBe("next");
    expect(r.courseSummaryUpdate?.summary).toBe("ok");
  });

  it("preserves raw bytes for persistence", () => {
    const raw = '<response>r</response>\n<assessment>{"questions":[]}</assessment>';
    expect(parseAssistantResponse(raw, { requireFinalTurnTags: false }).raw).toBe(raw);
  });
});
