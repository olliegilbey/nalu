import { describe, it, expect } from "vitest";
import { BASELINE, FRAMEWORK } from "@/lib/config/tuning";
import { toCerebrasJsonSchema } from "@/lib/llm/toCerebrasJsonSchema";
import { frameworkAndBaselineSchema } from "./frameworkAndBaseline";

/** One framework tier with the minimum example concepts. */
function tier(number: number) {
  return {
    number,
    name: `Tier ${number}`,
    description: "What a learner at this tier knows.",
    exampleConcepts: Array.from(
      { length: FRAMEWORK.minExampleConceptsPerTier },
      (_, i) => `concept ${number}.${i + 1}`,
    ),
  };
}

/** A graded MC baseline question on `tier`. */
function mc(id: string, tierNumber: number) {
  return {
    id,
    type: "multiple_choice" as const,
    prompt: "Which of these is correct?",
    options: { A: "opt a", B: "opt b", C: "opt c", D: "opt d" },
    correct: "A" as const,
    freetextRubric: "rubric text",
    conceptName: "some concept",
    tier: tierNumber,
  };
}

/** A valid merged response: 3 tiers, scope [1, 2], 4 questions per scoped tier. */
function valid() {
  return {
    framework: {
      userMessage: "Here is your ladder.",
      tiers: [tier(1), tier(2), tier(3)],
      estimatedStartingTier: 1,
      baselineScopeTiers: [1, 2],
    },
    baseline: {
      userMessage: "A quick check first.",
      questions: [1, 1, 1, 1, 2, 2, 2, 2].map((t, i) => mc(`b${i + 1}`, t)),
    },
  };
}

/** Issue paths for a failed parse, so a test can pin where each rule fires. */
function issuePaths(value: unknown): readonly string[] {
  const result = frameworkAndBaselineSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("frameworkAndBaselineSchema", () => {
  it("accepts a framework and a baseline written against its scope", () => {
    expect(issuePaths(valid())).toEqual([]);
  });

  // The FRAMEWORK tuning group still bounds the framework half.
  it("rejects fewer than FRAMEWORK.minTiers tiers", () => {
    const value = valid();
    const tiers = value.framework.tiers.slice(0, FRAMEWORK.minTiers - 1);
    expect(issuePaths({ ...value, framework: { ...value.framework, tiers } })).toContain(
      "framework.tiers",
    );
  });

  it("rejects a tier with too few example concepts", () => {
    const value = valid();
    const thin = { ...tier(1), exampleConcepts: ["only one"] };
    const tiers = [thin, tier(2), tier(3)];
    expect(issuePaths({ ...value, framework: { ...value.framework, tiers } })).toContain(
      "framework.tiers.0.exampleConcepts",
    );
  });

  it("rejects a baseline scope wider than FRAMEWORK.maxBaselineScopeSize", () => {
    const value = valid();
    const tiers = Array.from({ length: FRAMEWORK.maxBaselineScopeSize + 1 }, (_, i) => tier(i + 1));
    const baselineScopeTiers = tiers.map((t) => t.number);
    expect(
      issuePaths({ ...value, framework: { ...value.framework, tiers, baselineScopeTiers } }),
    ).toContain("framework.baselineScopeTiers");
  });

  // The BASELINE tuning group still bounds the baseline half.
  it("rejects fewer than BASELINE.minQuestions baseline questions", () => {
    const value = valid();
    const questions = value.baseline.questions.slice(0, BASELINE.minQuestions - 1);
    expect(issuePaths({ ...value, baseline: { ...value.baseline, questions } })).toEqual([
      "baseline.questions",
    ]);
  });

  it("rejects a baseline question missing its tier", () => {
    const value = valid();
    const { tier: _dropped, ...noTier } = mc("b1", 1);
    const questions = [noTier, ...value.baseline.questions.slice(1)];
    expect(issuePaths({ ...value, baseline: { ...value.baseline, questions } })).toEqual([
      "baseline.questions.0.tier",
    ]);
  });

  // The cross-half rule: the baseline probes only the tiers the framework scoped.
  it("rejects a baseline question outside the framework's baselineScopeTiers", () => {
    const value = valid();
    const questions = [...value.baseline.questions.slice(0, -1), mc("b8", 3)];
    const result = frameworkAndBaselineSchema.safeParse({
      ...value,
      baseline: { ...value.baseline, questions },
    });
    expect(result.success).toBe(false);
    const [issue] = result.error?.issues ?? [];
    expect(issue?.path).toEqual(["baseline", "questions", 7, "tier"]);
    // The message is a retry directive: it names the question and the scope.
    expect(issue?.message).toBe("question b8 tier 3 is outside baselineScopeTiers [1, 2]");
  });

  describe("wire", () => {
    const wire = () =>
      toCerebrasJsonSchema(frameworkAndBaselineSchema, { name: "framework_and_baseline" });

    // toCerebrasJsonSchema throws past Cerebras's 5000-char strict-mode cap.
    it("fits Cerebras's strict-mode schema budget", () => {
      expect(wire).not.toThrow();
    });

    // The model writes keys in schema order: the framework first, then a
    // baseline drawn from the scope it just chose.
    it("orders the framework before the baseline", () => {
      expect(Object.keys(wire().schema.properties ?? {})).toEqual(["framework", "baseline"]);
    });
  });
});
