import { describe, it, expect } from "vitest";
import { deriveRetryableWaveTurn } from "./deriveRetryableWaveTurn";
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";
import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";

const opener: WaveChatLogEntryForClient = { role: "assistant", kind: "text", content: "Hi." };
const orphan: WaveChatLogEntryForClient = { role: "user", kind: "text", content: "why?" };
const chatText: SubmitTurnPayload = { kind: "chat-text", text: "why?" };

describe("deriveRetryableWaveTurn", () => {
  it("offers the failed payload while the server holds its unanswered learner entry", () => {
    expect(deriveRetryableWaveTurn(chatText, [opener, orphan])).toBe(chatText);
  });

  it("offers the failed answers payload when their entry trails the log", () => {
    const answers: SubmitTurnPayload = {
      kind: "questionnaire-answers",
      questionnaireId: "q-1",
      answers: [{ id: "q1", kind: "mc", selected: "B" }],
    };
    const answered: WaveChatLogEntryForClient = {
      role: "user",
      kind: "answers",
      questionnaireId: "q-1",
      responses: [{ questionId: "q1", choice: "B" }],
    };
    expect(deriveRetryableWaveTurn(answers, [opener, answered])).toBe(answers);
  });

  it("offers nothing when the server never saved the entry", () => {
    // The Turn failed before its pre-LLM append: nothing is spent, and the
    // Composer already holds the text again.
    expect(deriveRetryableWaveTurn(chatText, [opener])).toBeNull();
  });

  it("offers nothing when the reply landed despite the client error", () => {
    // A network drop after the server saved the reply. A re-send here would
    // append a second copy and spend a Turn.
    const reply: WaveChatLogEntryForClient = {
      role: "assistant",
      kind: "text",
      content: "Because.",
    };
    expect(deriveRetryableWaveTurn(chatText, [opener, orphan, reply])).toBeNull();
  });

  it("offers nothing without a failure in this tab", () => {
    // A Turn in flight also leaves an unanswered learner entry.
    expect(deriveRetryableWaveTurn(null, [opener, orphan])).toBeNull();
  });

  it("offers nothing for an empty log", () => {
    expect(deriveRetryableWaveTurn(chatText, [])).toBeNull();
  });
});
