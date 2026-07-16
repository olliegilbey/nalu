import { describe, it, expect } from "vitest";
import { deriveWaveChatEntries } from "./deriveWaveChatEntries";
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";

const userText = (content: string): WaveChatLogEntryForClient => ({
  role: "user",
  kind: "text",
  content,
});
const userAnswers = (
  questionnaireId: string,
  responses: WaveChatLogEntryForClient extends infer T
    ? T extends { kind: "answers"; responses: infer R }
      ? R
      : never
    : never,
): WaveChatLogEntryForClient => ({
  role: "user",
  kind: "answers",
  questionnaireId,
  responses,
});
const assistantText = (content: string): WaveChatLogEntryForClient => ({
  role: "assistant",
  kind: "text",
  content,
});
const assistantQ = (
  questionnaireId: string,
  content: string,
  questions: WaveChatLogEntryForClient extends infer T
    ? T extends { kind: "text_with_questionnaire"; questions: infer Q }
      ? Q
      : never
    : never,
): WaveChatLogEntryForClient => ({
  role: "assistant",
  kind: "text_with_questionnaire",
  questionnaireId,
  content,
  questions,
});

describe("deriveWaveChatEntries", () => {
  it("returns empty array on empty log", () => {
    expect(deriveWaveChatEntries([])).toEqual([]);
  });

  it("maps user-text → user-text, assistant-text → assistant-text", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantText("Welcome."),
      userText("Tell me more."),
      assistantText("Sure."),
    ];
    expect(deriveWaveChatEntries(log)).toEqual([
      { kind: "assistant-text", content: "Welcome." },
      { kind: "user-text", content: "Tell me more." },
      { kind: "assistant-text", content: "Sure." },
    ]);
  });

  it("formats user-answers via formatAnswers using the matching questionnaire's questions", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantQ("q-1", "Try this:", [
        {
          id: "qa",
          type: "multiple_choice",
          prompt: "?",
          options: { A: "1", B: "2", C: "3", D: "4" },
          correctEnc: "enc",
          freetextRubric: "n/a",
        },
      ]),
      userAnswers("q-1", [{ questionId: "qa", choice: "B" }]),
    ];
    const chatEntries = deriveWaveChatEntries(log);
    // The answered questionnaire emits as plain assistant-text (no open Q).
    expect(chatEntries[0]).toEqual({ kind: "assistant-text", content: "Try this:" });
    expect(chatEntries[1]).toEqual({
      kind: "user-questionnaire-answers",
      content: "1. ? — 2",
    });
  });

  it("emits assistant-text-with-questionnaire for the LATEST unanswered text_with_questionnaire", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantQ("q-1", "Old card", [
        { id: "qa", type: "free_text", prompt: "Why?", freetextRubric: "n/a" },
      ]),
      userAnswers("q-1", [{ questionId: "qa", freetext: "because" }]),
      assistantQ("q-2", "New card", [
        { id: "qb", type: "free_text", prompt: "How?", freetextRubric: "n/a" },
      ]),
    ];
    const chatEntries = deriveWaveChatEntries(log);
    expect(chatEntries[0]).toEqual({ kind: "assistant-text", content: "Old card" }); // answered → text
    expect(chatEntries[2]).toEqual({
      kind: "assistant-text-with-questionnaire",
      content: "New card",
      questionnaire: {
        questionnaireId: "q-2",
        questions: [{ id: "qb", type: "free_text", prompt: "How?", freetextRubric: "n/a" }],
      },
    });
  });
});
