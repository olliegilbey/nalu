import { describe, it, expect } from "vitest";
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";

describe("findOpenQuestionnaire", () => {
  it("returns null when there are no entries", () => {
    expect(findOpenQuestionnaire([])).toBeNull();
  });

  it("returns null when no text_with_questionnaire has been emitted", () => {
    const log: WaveChatLog = [
      { role: "assistant", kind: "text", content: "hi" },
      { role: "user", kind: "text", content: "ok" },
    ];
    expect(findOpenQuestionnaire(log)).toBeNull();
  });

  it("returns the latest unanswered questionnaire", () => {
    const log: WaveChatLog = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "first card",
        questions: [
          {
            id: "qa",
            type: "multiple_choice",
            prompt: "?",
            options: { A: "1", B: "2", C: "3", D: "4" },
            correct: "A",
            freetextRubric: "n/a",
          },
        ],
      },
    ];
    const open = findOpenQuestionnaire(log);
    expect(open?.questionnaireId).toBe("q-1");
    expect(open?.questions).toHaveLength(1);
  });

  it("returns null once a user.answers references the latest questionnaire id", () => {
    const log: WaveChatLog = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "card",
        questions: [
          {
            id: "qa",
            type: "free_text",
            prompt: "Why?",
            freetextRubric: "n/a",
          },
        ],
      },
      {
        role: "user",
        kind: "answers",
        questionnaireId: "q-1",
        responses: [{ questionId: "qa", freetext: "because" }],
      },
    ];
    expect(findOpenQuestionnaire(log)).toBeNull();
  });

  it("returns the most recent of multiple unanswered text_with_questionnaire entries", () => {
    // Two questionnaires posed in succession, neither answered. The "open"
    // one is the latest — the older one is functionally abandoned.
    const log: WaveChatLog = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-old",
        content: "first",
        questions: [
          {
            id: "qa",
            type: "free_text",
            prompt: "old?",
            freetextRubric: "n/a",
          },
        ],
      },
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-new",
        content: "second",
        questions: [
          {
            id: "qb",
            type: "multiple_choice",
            prompt: "new?",
            options: { A: "1", B: "2", C: "3", D: "4" },
            correct: "B",
            freetextRubric: "n/a",
          },
        ],
      },
    ];
    const open = findOpenQuestionnaire(log);
    expect(open?.questionnaireId).toBe("q-new");
    expect(open?.questions).toHaveLength(1);
  });

  it("returns the new unanswered questionnaire in an interleaved log with all four entry kinds", () => {
    // Mixed log: user.text, assistant.text, an OLD answered questionnaire,
    // then a NEW unanswered questionnaire. Should return the NEW one.
    const log: WaveChatLog = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-old",
        content: "old card",
        questions: [
          {
            id: "q-old-a",
            type: "free_text",
            prompt: "explain",
            freetextRubric: "n/a",
          },
        ],
      },
      {
        role: "user",
        kind: "answers",
        questionnaireId: "q-old",
        responses: [{ questionId: "q-old-a", freetext: "done" }],
      },
      { role: "assistant", kind: "text", content: "nice, moving on" },
      { role: "user", kind: "text", content: "ok" },
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-new",
        content: "new card",
        questions: [
          {
            id: "q-new-a",
            type: "multiple_choice",
            prompt: "pick",
            options: { A: "1", B: "2", C: "3", D: "4" },
            correct: "C",
            freetextRubric: "n/a",
          },
        ],
      },
    ];
    const open = findOpenQuestionnaire(log);
    expect(open?.questionnaireId).toBe("q-new");
    expect(open?.questions).toHaveLength(1);
  });
});
