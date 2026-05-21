import { describe, it, expect } from "vitest";
import type { WaveChatLog, WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";
import { learnerEntryAlreadyAppended } from "./learnerEntryAlreadyAppended";

/**
 * Unit tests for `learnerEntryAlreadyAppended` — the resume-aware skip that
 * makes `submitWaveTurn`'s pre-LLM `chat_log` append idempotent (bug_001).
 */
describe("learnerEntryAlreadyAppended", () => {
  const textEntry: WaveChatLogEntry = { role: "user", kind: "text", content: "hello" };
  const answersEntry: WaveChatLogEntry = {
    role: "user",
    kind: "answers",
    questionnaireId: "Q",
    responses: [
      { questionId: "q1", choice: "B" },
      { questionId: "q2", freetext: "an answer" },
    ],
  };
  const assistantQuestionnaire: WaveChatLogEntry = {
    role: "assistant",
    kind: "text_with_questionnaire",
    questionnaireId: "Q",
    content: "pick one",
    questions: [],
  };

  it("returns false on an empty log", () => {
    expect(learnerEntryAlreadyAppended([], textEntry)).toBe(false);
  });

  it("returns false when the trailing entry is an assistant entry", () => {
    const log: WaveChatLog = [assistantQuestionnaire];
    expect(learnerEntryAlreadyAppended(log, answersEntry)).toBe(false);
  });

  // -- chat-text -----------------------------------------------------------
  it("returns true when the trailing entry is the same chat-text", () => {
    const log: WaveChatLog = [textEntry];
    expect(learnerEntryAlreadyAppended(log, { ...textEntry })).toBe(true);
  });

  it("returns false when the trailing chat-text content differs", () => {
    const log: WaveChatLog = [{ role: "user", kind: "text", content: "different" }];
    expect(learnerEntryAlreadyAppended(log, textEntry)).toBe(false);
  });

  it("returns false when the incoming entry is chat-text but trailing is answers", () => {
    const log: WaveChatLog = [answersEntry];
    expect(learnerEntryAlreadyAppended(log, textEntry)).toBe(false);
  });

  // -- questionnaire-answers ----------------------------------------------
  it("returns true when the trailing entry is the same answers submission", () => {
    const log: WaveChatLog = [answersEntry];
    expect(
      learnerEntryAlreadyAppended(log, {
        role: "user",
        kind: "answers",
        questionnaireId: "Q",
        responses: [
          { questionId: "q1", choice: "B" },
          { questionId: "q2", freetext: "an answer" },
        ],
      }),
    ).toBe(true);
  });

  it("returns false when the trailing answers target a different questionnaireId", () => {
    const log: WaveChatLog = [{ ...answersEntry, questionnaireId: "OTHER" }];
    expect(learnerEntryAlreadyAppended(log, answersEntry)).toBe(false);
  });

  it("returns false when an answer's choice differs", () => {
    const log: WaveChatLog = [
      {
        role: "user",
        kind: "answers",
        questionnaireId: "Q",
        responses: [
          { questionId: "q1", choice: "A" },
          { questionId: "q2", freetext: "an answer" },
        ],
      },
    ];
    expect(learnerEntryAlreadyAppended(log, answersEntry)).toBe(false);
  });

  it("returns false when an answer's freetext differs", () => {
    const log: WaveChatLog = [
      {
        role: "user",
        kind: "answers",
        questionnaireId: "Q",
        responses: [
          { questionId: "q1", choice: "B" },
          { questionId: "q2", freetext: "a DIFFERENT answer" },
        ],
      },
    ];
    expect(learnerEntryAlreadyAppended(log, answersEntry)).toBe(false);
  });

  it("returns false when the response counts differ", () => {
    const log: WaveChatLog = [
      {
        role: "user",
        kind: "answers",
        questionnaireId: "Q",
        responses: [{ questionId: "q1", choice: "B" }],
      },
    ];
    expect(learnerEntryAlreadyAppended(log, answersEntry)).toBe(false);
  });

  it("only inspects the trailing entry — an earlier match does not count", () => {
    // The same answers entry appears earlier, but the trailing entry is a
    // later assistant turn → not a retry orphan.
    const log: WaveChatLog = [answersEntry, assistantQuestionnaire];
    expect(learnerEntryAlreadyAppended(log, answersEntry)).toBe(false);
  });
});
