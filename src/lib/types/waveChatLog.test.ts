import { describe, it, expect } from "vitest";
import { waveChatLogEntrySchema, waveChatLogSchema } from "./jsonbWaveChatLog";

describe("waveChatLogEntrySchema", () => {
  it("parses a user-text entry", () => {
    const parsed = waveChatLogEntrySchema.parse({
      role: "user",
      kind: "text",
      content: "Tell me more.",
    });
    expect(parsed).toEqual({ role: "user", kind: "text", content: "Tell me more." });
  });

  it("parses a user-answers entry with responses", () => {
    const parsed = waveChatLogEntrySchema.parse({
      role: "user",
      kind: "answers",
      questionnaireId: "q-1",
      responses: [{ questionId: "qid-a", choice: "A" }],
    });
    expect(parsed.kind).toBe("answers");
  });

  it("parses an assistant-text entry", () => {
    expect(
      waveChatLogEntrySchema.parse({ role: "assistant", kind: "text", content: "Hello." }),
    ).toBeTruthy();
  });

  it("parses an assistant-text_with_questionnaire entry with MC question", () => {
    const parsed = waveChatLogEntrySchema.parse({
      role: "assistant",
      kind: "text_with_questionnaire",
      questionnaireId: "q-1",
      content: "Try this:",
      questions: [
        {
          id: "qid-a",
          type: "multiple_choice",
          prompt: "2+2?",
          options: { A: "3", B: "4", C: "5", D: "6" },
          correct: "B",
          freetextRubric: "n/a",
        },
      ],
    });
    expect(parsed.kind).toBe("text_with_questionnaire");
  });

  it("rejects an entry with an unknown kind", () => {
    expect(() =>
      waveChatLogEntrySchema.parse({ role: "user", kind: "bogus", content: "x" }),
    ).toThrow();
  });

  it("waveChatLogSchema accepts an empty array (the default for fresh waves)", () => {
    expect(waveChatLogSchema.parse([])).toEqual([]);
  });
});
