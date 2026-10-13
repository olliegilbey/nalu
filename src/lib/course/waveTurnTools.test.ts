import { describe, it, expect } from "vitest";
import type { Schema } from "ai";
import { QUESTIONNAIRE, WAVE } from "@/lib/config/tuning";
import { UNGRADED_RUBRIC, placeholderRubricDirective } from "@/lib/prompts/questionnaire";
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
    const { options, ...noOptions } = MC_QUESTION;
    const result = await schema.validate!({ questions: [noOptions] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(String(result.error)).toContain("is missing required options");
    }
  });

  // Issue #22: a quiz question is graded, so a free-text rubric must say
  // what a correct answer contains. A placeholder leaves the grader no key.
  it("questionnaire inputSchema rejects a free-text placeholder rubric, teacher-style directive", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
    for (const rubric of [UNGRADED_RUBRIC, "n/a"]) {
      const result = await schema.validate!({
        questions: [{ ...FT_QUESTION, freetextRubric: rubric }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(String(result.error)).toContain(placeholderRubricDirective(FT_QUESTION.id));
      }
    }
  });

  // The model reads the rubric rule and its floor before it writes, so a
  // short key does not cost a tool-error round trip.
  it("questionnaire tool wire states the rubric rule and its floor", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
    const wire = JSON.stringify(await schema.jsonSchema);
    expect(wire).toContain("what a correct answer must contain");
    expect(wire).toContain(`at least ${QUESTIONNAIRE.rubricMinChars} characters`);
  });

  // Issue #63: the description promised 1-3 questions but nothing enforced
  // the upper bound. The SDK feeds the violation back as a tool error.
  it("questionnaire inputSchema enforces the WAVE.quizMaxQuestions upper bound", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
    const questionsOf = (n: number) =>
      Array.from({ length: n }, (_v, i) => ({ ...FT_QUESTION, id: `q${i + 1}` }));
    const atCap = await schema.validate!({ questions: questionsOf(WAVE.quizMaxQuestions) });
    expect(atCap.success).toBe(true);
    const overCap = await schema.validate!({ questions: questionsOf(WAVE.quizMaxQuestions + 1) });
    expect(overCap.success).toBe(false);
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

  // Issue #61: a second signal for a staged questionId would grade the same
  // assessment row twice and double the client's XP floater. The first
  // grading stands; the duplicate is refused in a model-readable result.
  it("refuses a duplicate questionId within one call; the first signal stands", async () => {
    const { tools, collector } = buildWaveMidTurnTools();
    const result = await tools.recordComprehensionSignals.execute!(
      {
        signals: [
          {
            kind: "free-text",
            questionId: "q1",
            verdict: "correct",
            qualityScore: 5,
            rationale: "Nailed it. Extend next.",
          },
          {
            kind: "free-text",
            questionId: "q1",
            verdict: "incorrect",
            qualityScore: 0,
            rationale: "Second take. Should be refused.",
          },
          {
            kind: "free-text",
            questionId: "q1",
            verdict: "partial",
            qualityScore: 2,
            rationale: "Third take. Should be refused.",
          },
        ],
      },
      callOpts("c1"),
    );
    expect(collector.signals).toHaveLength(1);
    expect(collector.signals[0]).toMatchObject({ questionId: "q1", verdict: "correct" });
    // Each refused id is named once, however many times it repeated.
    expect(result).toMatchObject({ recorded: 1, rejected: ["q1"] });
    // The refusal names the next step, so the model does not resend and
    // burn loop Steps.
    expect((result as { reason?: string }).reason).toContain("Do not resend");
  });

  it("refuses a questionId already staged by an earlier call", async () => {
    const { tools, collector } = buildWaveMidTurnTools();
    await tools.recordComprehensionSignals.execute!(
      { signals: [{ kind: "mc-index", questionId: "q1", rationale: "Grasp. Extend." }] },
      callOpts("c1"),
    );
    const second = await tools.recordComprehensionSignals.execute!(
      {
        signals: [
          { kind: "mc-index", questionId: "q1", rationale: "Again. Refused." },
          { kind: "mc-index", questionId: "q2", rationale: "New. Staged." },
        ],
      },
      callOpts("c2"),
    );
    expect(collector.signals.map((s) => s.questionId)).toEqual(["q1", "q2"]);
    expect(collector.signals[0]?.rationale).toBe("Grasp. Extend.");
    expect(second).toMatchObject({ recorded: 1, rejected: ["q1"] });
  });

  it("keeps the plain result bytes when nothing is refused", async () => {
    const { tools } = buildWaveMidTurnTools();
    const result = await tools.recordComprehensionSignals.execute!(
      { signals: [{ kind: "mc-index", questionId: "q1", rationale: "Grasp. Extend." }] },
      callOpts("c1"),
    );
    expect(result).toEqual({ recorded: 1 });
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

  it.each([
    ["an empty", ""],
    ["a whitespace-only", "   "],
  ])("questionnaire inputSchema rejects %s conceptName", async (_label, conceptName) => {
    // `"   "` is a truthy string, so a presence-only check would let it
    // through. The trim-aware check must reject it before it becomes a
    // concept with a blank name.
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
    const result = await schema.validate!({ questions: [{ ...FT_QUESTION, conceptName }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(String(result.error)).toContain("is missing required conceptName");
    }
  });

  it("questionnaire inputSchema rejects an MC question without correct, verbatim directive", async () => {
    const { tools } = buildWaveMidTurnTools();
    const schema = asValidatingSchema(tools.presentQuestionnaire.inputSchema);
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
