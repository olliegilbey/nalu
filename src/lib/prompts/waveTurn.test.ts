import { describe, expect, it } from "vitest";
import { renderWaveTurnEnvelope, waveMidTurnSchema } from "./waveTurn";

describe("waveMidTurnSchema", () => {
  it("accepts a teaching-only turn (no signals, no questionnaire)", () => {
    const r = waveMidTurnSchema.safeParse({ userMessage: "Here's a beat." });
    expect(r.success).toBe(true);
  });

  it("accepts a turn with a questionnaire drop", () => {
    const r = waveMidTurnSchema.safeParse({
      userMessage: "Try these.",
      questionnaire: {
        questions: [
          {
            id: "q-w1-1",
            type: "free_text",
            prompt: "Why does demand slope down?",
            freetextRubric: "Looks for substitution + income effects.",
          },
        ],
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts mixed comprehension signals (mc-index + free-text)", () => {
    const r = waveMidTurnSchema.safeParse({
      userMessage: "Good.",
      comprehensionSignals: [
        { kind: "mc-index", questionId: "q-a", rationale: "Right click." },
        {
          kind: "free-text",
          questionId: "q-b",
          verdict: "partial",
          qualityScore: 3,
          rationale: "Got the gist, missed the example.",
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty userMessage", () => {
    expect(waveMidTurnSchema.safeParse({ userMessage: "" }).success).toBe(false);
  });
});

describe("renderWaveTurnEnvelope", () => {
  it("wraps learner input with stage label and <turns_remaining>", () => {
    const out = renderWaveTurnEnvelope({
      learnerInput: "<learner_reply>hello</learner_reply>",
      turnsRemaining: 5,
    });
    expect(out).toContain("<stage>teaching turn</stage>");
    expect(out).toContain("<turns_remaining>5</turns_remaining>");
    expect(out).toContain("<learner_reply>hello</learner_reply>");
  });

  it("inlines responseSchema when supplied (non-strict-mode path)", () => {
    const out = renderWaveTurnEnvelope({
      learnerInput: "x",
      turnsRemaining: 0,
      responseSchema: '{"type":"object"}',
    });
    expect(out).toContain('<response_schema>{"type":"object"}</response_schema>');
    // No blank line between turns_remaining and response_schema — bytes matter
    // for cache-prefix stability across turns.
    expect(out).not.toMatch(/<\/turns_remaining>\n\n<response_schema>/);
  });
});
