import { describe, it, expect } from "vitest";
import { deriveWaveTurns } from "./deriveWaveTurns";
import type { RenderedMessage } from "./getWaveState";
import type { OpenQuestionnaireForClient } from "./redactQuestionnaire";

// Convenience factory: builds a RenderedMessage with sensible defaults so each
// fixture stays focused on what it's testing.
function msg(
  partial: Pick<RenderedMessage, "id" | "kind" | "content"> & Partial<RenderedMessage>,
): RenderedMessage {
  return {
    turnIndex: 0,
    seq: 0,
    role: partial.kind === "assistant_response" ? "assistant" : "user",
    ...partial,
  };
}

describe("deriveWaveTurns", () => {
  it("returns empty array when there are no messages", () => {
    expect(deriveWaveTurns([], null)).toEqual([]);
  });

  it("maps user_message → user-text, card_answer → user-questionnaire-answers, assistant_response → assistant-text", () => {
    const messages: readonly RenderedMessage[] = [
      msg({ id: "a1", kind: "assistant_response", content: "Welcome to wave 1." }),
      msg({ id: "u1", kind: "user_message", content: "Tell me more." }),
      msg({ id: "a2", kind: "assistant_response", content: "Sure — concept X." }),
      msg({ id: "c1", kind: "card_answer", content: "1. Q — A" }),
      msg({ id: "a3", kind: "assistant_response", content: "Nice, on to concept Y." }),
    ];
    const turns = deriveWaveTurns(messages, null);
    expect(turns).toEqual([
      { kind: "assistant-text", content: "Welcome to wave 1." },
      { kind: "user-text", content: "Tell me more." },
      { kind: "assistant-text", content: "Sure — concept X." },
      { kind: "user-questionnaire-answers", content: "1. Q — A" },
      { kind: "assistant-text", content: "Nice, on to concept Y." },
    ]);
  });

  it("attaches the openQuestionnaire to the LATEST assistant_response when ids match", () => {
    const openQ: OpenQuestionnaireForClient = {
      questionnaireId: "a3",
      questions: [
        {
          id: "q1",
          type: "multiple_choice",
          prompt: "2+2?",
          options: { A: "3", B: "4", C: "5", D: "6" },
          correctEnc: "enc",
          freetextRubric: "n/a",
        },
      ],
    };
    const messages: readonly RenderedMessage[] = [
      msg({ id: "a1", kind: "assistant_response", content: "intro" }),
      msg({ id: "u1", kind: "user_message", content: "ok" }),
      msg({ id: "a3", kind: "assistant_response", content: "Try this card:" }),
    ];
    const turns = deriveWaveTurns(messages, openQ);

    expect(turns).toHaveLength(3);
    // First assistant turn stays plain even though a questionnaire exists —
    // attachment is restricted to the latest assistant_response.
    expect(turns[0]).toEqual({ kind: "assistant-text", content: "intro" });
    expect(turns[1]).toEqual({ kind: "user-text", content: "ok" });
    expect(turns[2]).toEqual({
      kind: "assistant-text-with-questionnaire",
      content: "Try this card:",
      questionnaire: {
        questionnaireId: "a3",
        questions: openQ.questions,
      },
    });
  });

  it("emits plain assistant-text when openQuestionnaire id does NOT match the latest assistant row (defensive)", () => {
    // openQuestionnaire references a row that isn't the latest assistant_response.
    // The defensive fallback keeps the scroll renderable as plain text.
    const openQ: OpenQuestionnaireForClient = {
      questionnaireId: "stale-id",
      questions: [],
    };
    const messages: readonly RenderedMessage[] = [
      msg({ id: "a-latest", kind: "assistant_response", content: "Latest assistant turn." }),
    ];
    const turns = deriveWaveTurns(messages, openQ);
    expect(turns).toEqual([{ kind: "assistant-text", content: "Latest assistant turn." }]);
  });

  it("falls back to plain assistant-text when openQuestionnaire is null", () => {
    const messages: readonly RenderedMessage[] = [
      msg({ id: "a1", kind: "assistant_response", content: "Just prose, no card." }),
    ];
    const turns = deriveWaveTurns(messages, null);
    expect(turns).toEqual([{ kind: "assistant-text", content: "Just prose, no card." }]);
  });
});
