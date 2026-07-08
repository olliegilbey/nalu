import { describe, it, expect } from "vitest";
import type { Schema } from "ai";
import { buildWaveMidTurnTools } from "./waveTurnTools";

/** Minimal ToolCallOptions stub — execute only reads none of it today. */
const callOpts = (id: string) => ({ toolCallId: id, messages: [] });

/**
 * Narrow a tool's `inputSchema` (typed as the FlexibleSchema union) to the
 * validating `Schema` wrapper our tools always build via `toToolInputSchema`.
 */
const asValidatingSchema = <T>(s: unknown): Schema<T> => s as Schema<T>;

/** Valid MC question matching the real questionSchema shape. */
const MC_QUESTION = {
  id: "q1",
  type: "multiple_choice" as const,
  prompt: "What does ownership move do?",
  options: { A: "a", B: "b", C: "c", D: "d" },
  correct: "A" as const,
  freetextRubric: "n/a",
  conceptName: "ownership",
};

/** Valid free-text question (no correct key — not applicable). */
const FT_QUESTION = {
  id: "q1",
  type: "free_text" as const,
  prompt: "Why does the borrow checker exist?",
  freetextRubric: "mentions aliasing XOR mutation",
  conceptName: "borrowing",
};

describe("buildWaveMidTurnTools", () => {
  it("stages a valid questionnaire into the collector as CANONICAL questions", async () => {
    const { tools, collector } = buildWaveMidTurnTools();
    const result = await tools.presentQuestionnaire.execute!(
      { questions: [MC_QUESTION] },
      callOpts("c1"),
    );
    expect(result).toEqual({ accepted: true, questionCount: 1 });
    expect(collector.questionnaire?.questions).toHaveLength(1);
    // Flat tool input maps to the canonical Question union member the
    // persistence layer types against.
    expect(collector.questionnaire?.questions[0]).toEqual(MC_QUESTION);
  });

  it("questionnaire inputSchema rejects an MC question without options, teacher-style directive", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to drop options
    const { options, ...noOptions } = MC_QUESTION;
    const result = await schema.validate!({ questions: [noOptions] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(String(result.error)).toContain("is missing required options");
    }
  });

  it("signals inputSchema rejects a free-text signal without verdict/qualityScore", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.recordComprehensionSignals.inputSchema);
    const result = await schema.validate!({
      signals: [{ kind: "free-text", questionId: "q2", rationale: "Half right. Revisit moves." }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(String(result.error)).toContain("missing required verdict and/or qualityScore");
    }
  });

  it("rejects a second questionnaire in the same turn with a model-readable refusal", async () => {
    const { tools, collector } = buildWaveMidTurnTools();
    await tools.presentQuestionnaire.execute!({ questions: [FT_QUESTION] }, callOpts("c1"));
    const second = await tools.presentQuestionnaire.execute!(
      { questions: [FT_QUESTION] },
      callOpts("c2"),
    );
    expect(second).toMatchObject({ accepted: false });
    expect(collector.questionnaire?.questions).toHaveLength(1); // first one kept
  });

  it("stages comprehension signals across multiple calls", async () => {
    const { tools, collector } = buildWaveMidTurnTools();
    await tools.recordComprehensionSignals.execute!(
      {
        signals: [
          { kind: "mc-index", questionId: "q1", rationale: "Click shows grasp. Extend next." },
        ],
      },
      callOpts("c1"),
    );
    await tools.recordComprehensionSignals.execute!(
      {
        signals: [
          {
            kind: "free-text",
            questionId: "q2",
            verdict: "partial",
            qualityScore: 3,
            rationale: "Half right. Revisit moves.",
          },
        ],
      },
      callOpts("c2"),
    );
    expect(collector.signals).toHaveLength(2);
    expect(collector.signals[0]?.kind).toBe("mc-index");
    expect(collector.signals[1]?.kind).toBe("free-text");
  });

  it("each build returns a fresh, independent collector", async () => {
    const first = buildWaveMidTurnTools();
    const second = buildWaveMidTurnTools();
    await first.tools.presentQuestionnaire.execute!({ questions: [MC_QUESTION] }, callOpts("c1"));
    expect(first.collector.questionnaire).not.toBeNull();
    expect(second.collector.questionnaire).toBeNull();
  });

  it("questionnaire inputSchema rejects a missing conceptName with the mega-schema's verbatim directive", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to drop conceptName
    const { conceptName, ...noConcept } = FT_QUESTION;
    const result = await schema.validate!({ questions: [noConcept] });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The directive strings were prompt-engineered on the mega-schema and
      // must survive verbatim (plan self-review checklist).
      expect(String(result.error)).toContain(
        "is missing required conceptName. Every teaching-quiz question must name the concept it assesses",
      );
    }
  });

  it("questionnaire inputSchema rejects an MC question without correct, verbatim directive", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to drop correct
    const { correct, ...noCorrect } = MC_QUESTION;
    const result = await schema.validate!({ questions: [noCorrect] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(String(result.error)).toContain(
        "is missing required correct key. Every teaching multiple-choice question must mark which option",
      );
    }
  });

  it("questionnaire inputSchema absorbs explicit nulls on optional fields (probe finding)", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
    // Models emit `"correct": null` / `"conceptName": null`-style explicit
    // nulls for inapplicable optionals; tier is genuinely optional here.
    const result = await schema.validate!({
      questions: [{ ...FT_QUESTION, tier: null }],
    });
    expect(result.success).toBe(true);
  });
});
