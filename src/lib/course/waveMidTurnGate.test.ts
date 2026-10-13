import { describe, expect, it } from "vitest";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
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

  it("fails CLOSED on prose beyond the blob-scan length bound (oversized leak must not pass)", () => {
    // The blob scan is O(braces × length) and bounded at 20k chars. Beyond
    // the bound we cannot prove the prose is clean, so the gate must reject
    // rather than wave a potentially JSON-laden wall of text through.
    const oversized =
      "word ".repeat(4_100) +
      `\n{ "questions": [{ "id": "q1", "type": "multiple_choice", "prompt": "?" }] }`;
    expect(oversized.length).toBeGreaterThan(20_000);
    const failure = validateWaveMidToolTurn(emptyCollector(), oversized, CHAT_PAYLOAD);
    expect(failure?.reason).toBe("tool_turn_gate");
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

  // --- Dumps with trailing text, invented wrappers, code formatting (#156) ---

  /** Asserts the gate rejects `prose` as a raw JSON dump. */
  const expectJsonDumpRejected = (prose: string) => {
    const failure = validateWaveMidToolTurn(emptyCollector(), prose, CHAT_PAYLOAD);
    expect(failure?.reason).toBe("tool_turn_gate");
    expect(failure?.detail).toContain("raw JSON object");
  };

  it("rejects a mid-line questionnaire dump with trailing prose", () => {
    expectJsonDumpRejected(
      'Here is your quiz: {"questions":[{"prompt":"…","correct":"B"}]} Good luck!',
    );
  });

  it("rejects an invented wrapper that nests a `correct` answer key", () => {
    expectJsonDumpRejected('Quiz time: {"items":[{"prompt":"?","correct":"B"}]} Have fun.');
  });

  it("rejects a top-level `correct` key", () => {
    expectJsonDumpRejected('The answer: {"correct": "B"}. Next question.');
  });

  it("matches braces string-aware, so a `}` inside a string does not end the object", () => {
    expectJsonDumpRejected(
      'Quiz: {"questions":[{"prompt":"Is } a brace?","correct":"B"}]} Good luck!',
    );
  });

  it("honours escaped quotes inside strings when matching braces", () => {
    expectJsonDumpRejected(
      'Quiz: {"questions":[{"prompt":"Say \\"}\\" aloud","correct":"B"}]} Good luck!',
    );
  });

  it("rejects a fenced dump: the gate is fence-blind", () => {
    expectJsonDumpRejected(
      'Here it is:\n```json\n{"questions":[{"prompt":"?","correct":"B"}]}\n```\nGood luck!',
    );
  });

  it("rejects a backticked dump: the gate is fence-blind", () => {
    expectJsonDumpRejected('Try this: `{"correct": "B"}` then answer.');
  });

  it("accepts a fenced teaching example with no envelope or `correct` key", () => {
    const prose = 'An object:\n```json\n{ "name": "Ada", "langs": ["en"] }\n```\nSee the braces?';
    expect(validateWaveMidToolTurn(emptyCollector(), prose, CHAT_PAYLOAD)).toBeNull();
  });

  it("accepts set notation", () => {
    const prose = "The set {a, b} has two members, and {} is empty.";
    expect(validateWaveMidToolTurn(emptyCollector(), prose, CHAT_PAYLOAD)).toBeNull();
  });

  it("accepts template placeholders like {{name}}", () => {
    const prose = "In Handlebars, {{name}} prints the name.";
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
