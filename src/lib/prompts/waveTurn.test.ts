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
            conceptName: "Demand curve",
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

  // A teaching questionnaire question is a graded concept-check: it becomes an
  // `assessments` row keyed on a `concept`, so `conceptName` is mandatory.
  // The shared `questionSchema` leaves it optional (clarify needs the looser
  // shape); the wave-mid stage tightens it here. Without this, an omission
  // passes validation and then crashes `insertNewQuestionnaire` with a 500.
  it("rejects a questionnaire free-text question missing conceptName", () => {
    const r = waveMidTurnSchema.safeParse({
      userMessage: "Try this.",
      questionnaire: {
        questions: [
          {
            id: "q1",
            type: "free_text",
            prompt: "What would you adjust to keep the dough supple?",
            freetextRubric: "Looks for a concrete, sensible fix.",
          },
        ],
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // The refine message becomes the model-facing retry directive — it must
      // name the missing field so the model can self-correct.
      expect(r.error.issues.some((i) => i.message.includes("conceptName"))).toBe(true);
    }
  });

  it("rejects a questionnaire question with an empty-string conceptName", () => {
    // `questionSchema.conceptName` is `z.string().optional()`, so "" is a valid
    // value — but `insertNewQuestionnaire`'s backstop is `!q.conceptName`, which
    // rejects "". The superRefine must agree, or "" slips through to a 500.
    const r = waveMidTurnSchema.safeParse({
      userMessage: "Try this.",
      questionnaire: {
        questions: [
          {
            id: "q1",
            type: "free_text",
            prompt: "What would you adjust?",
            freetextRubric: "Looks for a concrete fix.",
            conceptName: "",
          },
        ],
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a questionnaire question with a whitespace-only conceptName", () => {
    // `"   "` is a truthy `z.string()` value, so a presence-only check would
    // let it through; the trim-aware gate must reject it before it becomes a
    // concept named only whitespace.
    const r = waveMidTurnSchema.safeParse({
      userMessage: "Try this.",
      questionnaire: {
        questions: [
          {
            id: "q1",
            type: "free_text",
            prompt: "What would you adjust?",
            freetextRubric: "Looks for a concrete fix.",
            conceptName: "   ",
          },
        ],
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a questionnaire multiple-choice question missing conceptName", () => {
    const r = waveMidTurnSchema.safeParse({
      userMessage: "Quick check.",
      questionnaire: {
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "Which flour suits fresh pasta?",
            options: { A: "00 flour", B: "bread flour", C: "cake flour", D: "rye flour" },
            freetextRubric: "Grade the escape answer for the same idea.",
            correct: "A",
          },
        ],
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a questionnaire multiple-choice question missing correct", () => {
    const r = waveMidTurnSchema.safeParse({
      userMessage: "Quick check.",
      questionnaire: {
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "Which flour suits fresh pasta?",
            options: { A: "00 flour", B: "bread flour", C: "cake flour", D: "rye flour" },
            freetextRubric: "Grade the escape answer for the same idea.",
            conceptName: "Flour selection",
          },
        ],
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes("correct"))).toBe(true);
    }
  });

  it("accepts a fully-specified graded multiple-choice question", () => {
    const r = waveMidTurnSchema.safeParse({
      userMessage: "Quick check.",
      questionnaire: {
        questions: [
          {
            id: "q1",
            type: "multiple_choice",
            prompt: "Which flour suits fresh pasta?",
            options: { A: "00 flour", B: "bread flour", C: "cake flour", D: "rye flour" },
            freetextRubric: "Grade the escape answer for the same idea.",
            conceptName: "Flour selection",
            correct: "A",
          },
        ],
      },
    });
    expect(r.success).toBe(true);
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
