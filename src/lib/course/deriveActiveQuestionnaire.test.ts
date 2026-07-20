import { describe, it, expect } from "vitest";
import { deriveActiveQuestionnaire } from "./deriveActiveQuestionnaire";
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

describe("deriveActiveQuestionnaire", () => {
  it("returns null when the log has no questionnaire (none case)", () => {
    const log: WaveChatLogEntryForClient[] = [assistantText("Welcome."), userText("Hi.")];
    expect(deriveActiveQuestionnaire(log, "wave-1")).toBeNull();
    // Empty log too.
    expect(deriveActiveQuestionnaire([], "wave-1")).toBeNull();
  });

  it("returns the latest unanswered questionnaire (active case)", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantQ("q-1", "Try this:", [{ id: "qa", type: "free_text", prompt: "Why?" }]),
    ];
    expect(deriveActiveQuestionnaire(log, "wave-42")).toEqual({
      kind: "wave",
      questions: [{ id: "qa", prompt: "Why?", options: [] }],
      questionsKey: "q-1",
      persistKey: "nalu:wave:wave-42:q:q-1",
    });
  });

  it("returns null when the latest questionnaire is already answered (already-answered case)", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantQ("q-1", "Try this:", [{ id: "qa", type: "free_text", prompt: "Why?" }]),
      userAnswers("q-1", [{ questionId: "qa", freetext: "because" }]),
    ];
    expect(deriveActiveQuestionnaire(log, "wave-1")).toBeNull();
  });

  it("ignores an earlier answered questionnaire when a later one is still open", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantQ("q-1", "Old card", [{ id: "qa", type: "free_text", prompt: "Why?" }]),
      userAnswers("q-1", [{ questionId: "qa", freetext: "because" }]),
      assistantQ("q-2", "New card", [{ id: "qb", type: "free_text", prompt: "How?" }]),
    ];
    expect(deriveActiveQuestionnaire(log, "wave-7")).toEqual({
      kind: "wave",
      questions: [{ id: "qb", prompt: "How?", options: [] }],
      questionsKey: "q-2",
      persistKey: "nalu:wave:wave-7:q:q-2",
    });
  });
});
