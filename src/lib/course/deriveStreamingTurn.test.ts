import { describe, it, expect } from "vitest";
import { deriveStreamingTurn } from "./deriveStreamingTurn";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";

// The wire carries the REDACTED tool input (no `correct`, no
// `freetextRubric`), a structural subset of the typed input. Fixtures mirror
// the wire, so they cast through `unknown`.
const assistant = (id: string, parts: readonly unknown[]): WaveTurnUIMessage =>
  ({ id, role: "assistant", parts }) as unknown as WaveTurnUIMessage;
const user = (id: string, text: string): WaveTurnUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const text = (t: string) => ({ type: "text", text: t });
const reset = (attempt: number) => ({ type: "data-turn-reset", data: { attempt } });
const questionnaire = (state: string, questionId: string) => ({
  type: "tool-presentQuestionnaire",
  toolCallId: `call-${questionId}`,
  state,
  input: { questions: [{ id: questionId, type: "free_text", prompt: `${questionId}?` }] },
});

describe("deriveStreamingTurn", () => {
  it("is empty when no assistant message is in flight", () => {
    const idle = { streamingText: "", streamingQuestions: null };
    expect(deriveStreamingTurn([])).toEqual(idle);
    expect(deriveStreamingTurn([user("u1", "Hi")])).toEqual(idle);
  });

  it("joins the text parts of the LAST assistant message only", () => {
    const messages = [
      assistant("a1", [text("Old turn.")]),
      user("u2", "Next"),
      assistant("a2", [text("Streaming "), { type: "step-start" }, text("prose.")]),
    ];
    expect(deriveStreamingTurn(messages).streamingText).toBe("Streaming prose.");
  });

  it("drops every part before the LAST data-turn-reset marker", () => {
    // Two validation retries: only the third attempt's parts may render.
    const messages = [
      assistant("a1", [
        text("Attempt 0."),
        questionnaire("input-available", "stale0"),
        reset(1),
        text("Attempt 1."),
        questionnaire("input-available", "stale1"),
        reset(2),
        text("Clean retry."),
      ]),
    ];
    expect(deriveStreamingTurn(messages)).toEqual({
      streamingText: "Clean retry.",
      // The only tool parts sit before the last reset, so none survive.
      streamingQuestions: null,
    });
  });

  it("keeps every part when no reset marker is present", () => {
    const messages = [assistant("a1", [text("One "), text("attempt.")])];
    expect(deriveStreamingTurn(messages).streamingText).toBe("One attempt.");
  });

  it("adapts the questionnaire part once its input is available", () => {
    const messages = [
      assistant("a1", [
        text("Try this:"),
        {
          type: "tool-presentQuestionnaire",
          toolCallId: "call-1",
          state: "input-available",
          input: {
            questions: [
              {
                id: "q1",
                type: "multiple_choice",
                prompt: "Which?",
                options: { A: "a", B: "b", C: "c", D: "d" },
                tier: 2,
              },
              { id: "q2", type: "free_text", prompt: "Why?" },
            ],
          },
        },
      ]),
    ];
    expect(deriveStreamingTurn(messages).streamingQuestions).toEqual([
      { id: "q1", prompt: "Which?", options: ["a", "b", "c", "d"], tier: 2 },
      { id: "q2", prompt: "Why?", options: [], tier: undefined },
    ]);
  });

  it("keeps the questionnaire preview once the tool output is available", () => {
    const messages = [assistant("a1", [questionnaire("output-available", "q1")])];
    expect(deriveStreamingTurn(messages).streamingQuestions).toEqual([
      { id: "q1", prompt: "q1?", options: [], tier: undefined },
    ]);
  });

  // Issue #117: an invalid first call reaches the client as an `output-error`
  // part (the SDK sets `input: undefined`). The model then self-corrects
  // in-loop with a second, valid call under a new toolCallId.
  it("previews the valid questionnaire call that follows an errored one", () => {
    const errored = {
      type: "tool-presentQuestionnaire",
      toolCallId: "call-bad",
      state: "output-error",
      input: undefined,
      errorText: "Invalid input.",
    };
    const messages = [assistant("a1", [errored, questionnaire("input-available", "q2")])];
    expect(deriveStreamingTurn(messages).streamingQuestions).toEqual([
      { id: "q2", prompt: "q2?", options: [], tier: undefined },
    ]);
  });

  it("shows no preview while the tool input still streams or after the tool errors", () => {
    for (const state of ["input-streaming", "output-error"]) {
      const messages = [assistant("a1", [questionnaire(state, "q1")])];
      expect(deriveStreamingTurn(messages).streamingQuestions).toBeNull();
    }
  });
});
