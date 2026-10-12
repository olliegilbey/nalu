import { describe, it, expect } from "vitest";
import { BASELINE, FRAMEWORK } from "@/lib/config/tuning";
import { makeBaselineSchema } from "./baseline";

describe("makeBaselineSchema", () => {
  // Scope tiers used throughout this block.
  const SCOPE_TIERS = [1, 2, 3] as const;

  /**
   * Builds a complete MC question payload matching `questionSchema`.
   * Uses `prompt` (not `question`) per the shared question shape.
   */
  function fullMc(id: string, tier: number) {
    return {
      id,
      type: "multiple_choice" as const,
      prompt: "Which of these is correct?",
      options: { A: "opt a", B: "opt b", C: "opt c", D: "opt d" },
      correct: "A" as const,
      freetextRubric: "rubric text",
      conceptName: "some concept",
      tier,
    };
  }

  /** Builds a complete free-text question payload matching `questionSchema`. */
  function fullFt(id: string, tier: number) {
    return {
      id,
      type: "free_text" as const,
      prompt: "Explain this concept.",
      freetextRubric: "rubric text",
      conceptName: "some concept",
      tier,
    };
  }

  /**
   * Wraps a question list in the factory's nested `{ userMessage, questions: { questions: [...] } }` shape.
   * Outer `questions` is the questionnaire wrapper; inner array is the questions.
   * Takes `unknown[]` so tests for "missing field" fixtures don't need to match the full type.
   */
  function wrap(qs: unknown[]) {
    return {
      userMessage: "Here are your baseline questions.",
      questions: { questions: qs },
    };
  }

  it("accepts a valid payload within scope", () => {
    // minQuestions (7) questions spread across tiers 1/2/3.
    const qs = [
      fullMc("b1", 1),
      fullFt("b2", 1),
      fullMc("b3", 1),
      fullMc("b4", 2),
      fullFt("b5", 2),
      fullMc("b6", 2),
      fullMc("b7", 3),
    ];
    const schema = makeBaselineSchema({ scopeTiers: SCOPE_TIERS });
    expect(() => schema.parse(wrap(qs))).not.toThrow();
  });

  it("rejects a question with a tier outside the requested scope", () => {
    const qs = [
      fullMc("b1", 1),
      fullFt("b2", 1),
      fullMc("b3", 1),
      fullMc("b4", 2),
      fullFt("b5", 2),
      fullMc("b6", 2),
      fullMc("b7", 99), // tier 99 is out of scope
    ];
    const schema = makeBaselineSchema({ scopeTiers: SCOPE_TIERS });
    expect(() => schema.parse(wrap(qs))).toThrow(/outside the requested scope/i);
  });

  it("rejects a question missing conceptName", () => {
    const noConceptQ = {
      id: "b1",
      type: "free_text" as const,
      prompt: "Explain this.",
      freetextRubric: "rubric",
      // conceptName intentionally omitted
      tier: 1,
    };
    // Fill remaining to minQuestions.
    const qs = [
      noConceptQ,
      ...Array.from({ length: BASELINE.minQuestions - 1 }, (_, i) => fullMc(`b${i + 2}`, 1)),
    ];
    const schema = makeBaselineSchema({ scopeTiers: SCOPE_TIERS });
    expect(() => schema.parse(wrap(qs))).toThrow(/missing required conceptname/i);
  });

  it("rejects a question missing tier", () => {
    const noTierQ = {
      id: "b1",
      type: "free_text" as const,
      prompt: "Explain this.",
      freetextRubric: "rubric",
      conceptName: "concept",
      // tier intentionally omitted
    };
    const qs = [
      noTierQ,
      ...Array.from({ length: BASELINE.minQuestions - 1 }, (_, i) => fullMc(`b${i + 2}`, 1)),
    ];
    const schema = makeBaselineSchema({ scopeTiers: SCOPE_TIERS });
    expect(() => schema.parse(wrap(qs))).toThrow(/missing required tier/i);
  });

  it("rejects an MC question missing the correct key", () => {
    const noCorrectQ = {
      id: "b1",
      type: "multiple_choice" as const,
      prompt: "Which?",
      options: { A: "a", B: "b", C: "c", D: "d" },
      // correct intentionally omitted
      freetextRubric: "rubric",
      conceptName: "concept",
      tier: 1,
    };
    const qs = [
      noCorrectQ,
      ...Array.from({ length: BASELINE.minQuestions - 1 }, (_, i) => fullMc(`b${i + 2}`, 1)),
    ];
    const schema = makeBaselineSchema({ scopeTiers: SCOPE_TIERS });
    expect(() => schema.parse(wrap(qs))).toThrow(/missing required correct key/i);
  });

  it("rejects duplicate question ids", () => {
    // Two questions with id "b1".
    const qs = Array.from({ length: BASELINE.minQuestions }, (_, i) =>
      fullMc(i === 0 ? "b1" : `b${i + 1}`, 1),
    );
    // Force the last question to also have id "b1".
    const withDupe = [...qs.slice(0, -1), { ...qs[qs.length - 1]!, id: "b1" }];
    const schema = makeBaselineSchema({ scopeTiers: SCOPE_TIERS });
    expect(() => schema.parse(wrap(withDupe))).toThrow(/duplicate question ids/i);
  });

  // Issue #129: a flat "3 per tier" rule asks for 6 questions on a 2-tier
  // scope, below the floor of 7, so the model padded with out-of-scope tiers.
  // Every legal scope size (1..maxBaselineScopeSize) must render a count rule
  // the model can satisfy, and a baseline that follows it must parse.
  describe("count rule per scope size", () => {
    const scopes = Array.from({ length: FRAMEWORK.maxBaselineScopeSize }, (_, i) => ({
      scopeTiers: Array.from({ length: i + 1 }, (_, t) => t + 1),
    }));

    // PRD §4.1 states these counts. Pin them so the PRD and the formula agree.
    it("renders 7 for one tier, 4 per tier for two, 3 per tier for three", () => {
      const perTierFor = (scopeTiers: readonly number[]) =>
        Number(
          /(\d+) per tier/.exec(
            makeBaselineSchema({ scopeTiers }).shape.questions.shape.questions.description ?? "",
          )?.[1],
        );
      expect([[1], [1, 2], [1, 2, 3]].map(perTierFor)).toEqual([7, 4, 3]);
    });

    it.each(scopes)(
      "scope $scopeTiers renders a satisfiable count that parses",
      ({ scopeTiers }) => {
        const schema = makeBaselineSchema({ scopeTiers });
        const description = schema.shape.questions.shape.questions.description ?? "";

        // Read the per-tier count the model is told to write.
        const perTier = Number(/(\d+) per tier/.exec(description)?.[1]);
        const total = perTier * scopeTiers.length;
        expect(total).toBeGreaterThanOrEqual(BASELINE.minQuestions);
        expect(total).toBeLessThanOrEqual(BASELINE.maxQuestions);
        // The rule states the same total and names the in-scope tiers.
        expect(description).toContain(`Exactly ${total} questions`);
        expect(description).toContain(`[${scopeTiers.join(", ")}]`);

        // A baseline that follows the rule exactly: perTier questions per tier,
        // alternating MC and free text, ids b1..bN in order.
        const qs = scopeTiers
          .flatMap((tier) => Array.from({ length: perTier }, () => tier))
          .map((tier, i) => (i % 2 === 0 ? fullMc(`b${i + 1}`, tier) : fullFt(`b${i + 1}`, tier)));
        expect(() => schema.parse(wrap(qs))).not.toThrow();
      },
    );
  });
});
