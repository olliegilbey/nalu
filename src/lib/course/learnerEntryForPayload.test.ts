import { describe, it, expect } from "vitest";
import { learnerEntryForPayload } from "./learnerEntryForPayload";

describe("learnerEntryForPayload", () => {
  it("saves chat text as a user text entry", () => {
    expect(learnerEntryForPayload({ kind: "chat-text", text: "why?" })).toEqual({
      role: "user",
      kind: "text",
      content: "why?",
    });
  });

  it("saves answers as responses in the payload's order, without fromEscape", () => {
    const entry = learnerEntryForPayload({
      kind: "questionnaire-answers",
      questionnaireId: "q-1",
      answers: [
        { id: "q2", kind: "freetext", text: "because", fromEscape: true },
        { id: "q1", kind: "mc", selected: "B" },
      ],
    });
    expect(entry).toEqual({
      role: "user",
      kind: "answers",
      questionnaireId: "q-1",
      responses: [
        { questionId: "q2", freetext: "because" },
        { questionId: "q1", choice: "B" },
      ],
    });
  });
});
