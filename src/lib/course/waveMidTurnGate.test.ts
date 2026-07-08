import { describe, expect, it } from "vitest";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import type { WaveTurnCollector } from "./waveTurnTools";
import type { SubmitTurnPayload } from "./buildLearnerInput";
import { validateWaveMidToolTurn } from "./waveMidTurnGate";

const CHAT_PAYLOAD: SubmitTurnPayload = { kind: "chat-text", text: "tell me more" };

const ANSWERS_PAYLOAD: SubmitTurnPayload = {
  kind: "questionnaire-answers",
  questionnaireId: "qn-1",
  answers: [
    { id: "q1", kind: "mc", selected: "B" },
    { id: "q2", kind: "freetext", text: "because ownership moves", fromEscape: false },
  ],
};

const emptyCollector = (): WaveTurnCollector => ({ questionnaire: null, signals: [] });

describe("validateWaveMidToolTurn", () => {
  it("accepts a pure teaching turn: prose present, no tools staged", () => {
    expect(
      validateWaveMidToolTurn(emptyCollector(), "Ownership means...", CHAT_PAYLOAD),
    ).toBeNull();
  });

  it("rejects a turn whose learner-visible prose is empty/whitespace", () => {
    const failure = validateWaveMidToolTurn(emptyCollector(), "  \n", CHAT_PAYLOAD);
    expect(failure).toBeInstanceOf(ValidationGateFailure);
    expect(failure?.reason).toBe("tool_turn_gate");
    expect(failure?.detail).toContain("teaching prose");
  });

  it("rejects prose that IS a raw mega-schema JSON envelope (legacy-context imitation)", () => {
    const blob = JSON.stringify({ userMessage: "Hi!", questionnaire: { questions: [] } });
    const failure = validateWaveMidToolTurn(emptyCollector(), blob, CHAT_PAYLOAD);
    expect(failure?.reason).toBe("tool_turn_gate");
    expect(failure?.detail).toContain("raw JSON object");
  });

  it("rejects prose with a TRAILING questionnaire JSON blob (observed live)", () => {
    const prose = `Great! Let's learn konnichiwa.\n\n{ "questions": [{ "id": "q1", "type": "multiple_choice", "prompt": "?" }] }`;
    const failure = validateWaveMidToolTurn(emptyCollector(), prose, CHAT_PAYLOAD);
    expect(failure?.reason).toBe("tool_turn_gate");
    expect(failure?.detail).toContain("raw JSON object");
  });

  it("accepts prose that merely mentions JSON or contains an unrelated snippet", () => {
    const prose =
      'In JSON you write objects like { "name": "value" } - braces around key/value pairs.';
    expect(validateWaveMidToolTurn(emptyCollector(), prose, CHAT_PAYLOAD)).toBeNull();
  });

  it("rejects answered questions with no grading signals, naming the missing ids", () => {
    const failure = validateWaveMidToolTurn(emptyCollector(), "Nice try!", ANSWERS_PAYLOAD);
    expect(failure).toBeInstanceOf(ValidationGateFailure);
    expect(failure?.detail).toContain("recordComprehensionSignals");
    expect(failure?.detail).toContain("q1");
    expect(failure?.detail).toContain("q2");
  });

  it("rejects partial grading coverage, naming only the ungraded ids", () => {
    const collector: WaveTurnCollector = {
      questionnaire: null,
      signals: [{ kind: "mc-index", questionId: "q1", rationale: "Two sentences. Here." }],
    };
    const failure = validateWaveMidToolTurn(collector, "Good effort!", ANSWERS_PAYLOAD);
    expect(failure?.detail).not.toContain("q1");
    expect(failure?.detail).toContain("q2");
  });

  it("accepts full grading coverage of the submitted answers", () => {
    const collector: WaveTurnCollector = {
      questionnaire: null,
      signals: [
        { kind: "mc-index", questionId: "q1", rationale: "Two sentences. Here." },
        {
          kind: "free-text",
          questionId: "q2",
          verdict: "correct",
          qualityScore: 4,
          rationale: "Two sentences. Here.",
        },
      ],
    };
    expect(validateWaveMidToolTurn(collector, "Both right!", ANSWERS_PAYLOAD)).toBeNull();
  });
});
