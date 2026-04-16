import { describe, it, expect } from "vitest";
import { BASELINE, FRAMEWORK } from "@/lib/config/tuning";
import { buildBaselinePrompt, type BaselineAssessment } from "./baseline";
import {
  buildBaselineEvaluationPrompt,
  baselineEvaluationSchema,
  type BaselineEvaluationItem,
} from "./baselineEvaluation";
import type { Framework } from "./framework";

function validFramework(): Framework {
  const tiers = Array.from({ length: FRAMEWORK.minTiers }, (_, i) => ({
    number: i + 1,
    name: `Tier ${i + 1}`,
    description: "Description.",
    exampleConcepts: Array.from(
      { length: FRAMEWORK.minExampleConceptsPerTier },
      (_, j) => `c${j + 1}`,
    ),
  }));
  return {
    tiers,
    estimatedStartingTier: 2,
    baselineScopeTiers: [1, 2, 3].slice(0, FRAMEWORK.minTiers),
  } as Framework;
}

function validBaseline(): BaselineAssessment {
  const questions = Array.from({ length: BASELINE.minQuestions }, (_, i) => ({
    id: `b${i + 1}`,
    tier: 1,
    conceptName: "concept",
    type: "multiple_choice" as const,
    question: "q?",
    options: { A: "a", B: "b", C: "c", D: "d" },
    correct: "A" as const,
    freetextRubric: "rubric",
  }));
  return { questions } as BaselineAssessment;
}

function item(id: string, overrides: Partial<BaselineEvaluationItem> = {}): BaselineEvaluationItem {
  return {
    questionId: id,
    conceptName: "concept",
    tier: 1,
    question: "q?",
    rubric: "rubric",
    learnerProse: "my answer",
    viaEscape: false,
    ...overrides,
  };
}

describe("buildBaselineEvaluationPrompt", () => {
  it("continues the baseline conversation: 8 messages (adds baseline-assistant + grading-task)", () => {
    const messages = buildBaselineEvaluationPrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
      baseline: validBaseline(),
      items: [item("b1")],
    });
    expect(messages).toHaveLength(8);
    expect(messages[0]?.role).toBe("system");
    expect(messages[6]?.role).toBe("assistant"); // baseline JSON
    expect(messages[7]?.role).toBe("user"); // grading task
  });

  it("the leading messages are byte-identical to the baseline turn (cache prefix)", () => {
    // Scoping is one conversation — every turn shares the prior history
    // verbatim so the cached prefix keeps growing.
    const topic = "Rust";
    const clarifications = [{ question: "q?", answer: "a" }];
    const framework = validFramework();
    const baseline = validBaseline();
    const baselineMessages = buildBaselinePrompt({ topic, clarifications, framework });
    const evalMessages = buildBaselineEvaluationPrompt({
      topic,
      clarifications,
      framework,
      baseline,
      items: [item("b1")],
    });
    baselineMessages.forEach((m, i) => {
      expect(evalMessages[i]?.content).toBe(m.content);
      expect(evalMessages[i]?.role).toBe(m.role);
    });
  });

  it("the baseline-assistant message is the baseline JSON", () => {
    const baseline = validBaseline();
    const messages = buildBaselineEvaluationPrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
      baseline,
      items: [item("b1")],
    });
    const assistant = messages[6];
    expect(JSON.parse(String(assistant?.content))).toEqual(baseline);
  });

  it("grading-task user message contains the 0-5 rubric and renames for non-engagement", () => {
    const messages = buildBaselineEvaluationPrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
      baseline: validBaseline(),
      items: [item("b1")],
    });
    const text = String(messages[7]?.content).toLowerCase();
    // The rubric is inlined verbatim; keyword presence is enough to
    // confirm it's there without locking in exact phrasing.
    expect(text).toContain("quality");
    expect(text).toContain("non-engagement");
    expect(text).toContain("passing");
  });

  it("freetext-escape items prepend the P-AC-03 prefix INSIDE the sanitised user_message block", () => {
    // Escape-on-MC answers must carry the prefix so the grader interprets
    // the prose in context. The whole thing — prefix + prose — is treated
    // as untrusted data inside <user_message>.
    const messages = buildBaselineEvaluationPrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
      baseline: validBaseline(),
      items: [item("b1", { learnerProse: "not sure", viaEscape: true })],
    });
    const text = String(messages[7]?.content);
    expect(text).toContain(BASELINE.freetextEscapePrefix);
    // Prefix lives inside the sanitised envelope, not adjacent to it.
    const tagIdx = text.indexOf("<user_message>");
    const prefixIdx = text.indexOf(BASELINE.freetextEscapePrefix);
    expect(prefixIdx).toBeGreaterThan(tagIdx);
  });

  it("sanitises the learner prose so angle brackets never reach raw form", () => {
    const messages = buildBaselineEvaluationPrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
      baseline: validBaseline(),
      items: [item("b1", { learnerProse: "<script>x</script>" })],
    });
    const text = String(messages[7]?.content);
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain("<script>");
  });

  it("each batch item names its questionId, concept, tier, rubric and viaEscape", () => {
    const messages = buildBaselineEvaluationPrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
      baseline: validBaseline(),
      items: [
        item("b1", { conceptName: "c1", tier: 1, rubric: "R1", learnerProse: "A1" }),
        item("b2", { conceptName: "c2", tier: 2, rubric: "R2", learnerProse: "A2" }),
      ],
    });
    const text = String(messages[7]?.content);
    expect(text).toContain("questionId: b1");
    expect(text).toContain("questionId: b2");
    expect(text).toContain("conceptName: c1");
    expect(text).toContain("conceptName: c2");
    expect(text).toContain("rubric: R1");
    expect(text).toContain("rubric: R2");
    expect(text).toContain("viaEscape: false");
  });
});

describe("baselineEvaluationSchema", () => {
  it("accepts a well-formed single-item response", () => {
    const result = baselineEvaluationSchema.safeParse({
      evaluations: [
        {
          questionId: "b1",
          conceptName: "concept",
          qualityScore: 3,
          isCorrect: true,
          rationale: "fine",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty evaluations array", () => {
    expect(baselineEvaluationSchema.safeParse({ evaluations: [] }).success).toBe(false);
  });

  it("rejects quality scores outside 0–5", () => {
    const result = baselineEvaluationSchema.safeParse({
      evaluations: [
        {
          questionId: "b1",
          conceptName: "c",
          qualityScore: 7,
          isCorrect: true,
          rationale: "r",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer / fractional quality scores", () => {
    const result = baselineEvaluationSchema.safeParse({
      evaluations: [
        {
          questionId: "b1",
          conceptName: "c",
          qualityScore: 3.5,
          isCorrect: true,
          rationale: "r",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty strings in required text fields", () => {
    const result = baselineEvaluationSchema.safeParse({
      evaluations: [
        {
          questionId: "b1",
          conceptName: "",
          qualityScore: 3,
          isCorrect: true,
          rationale: "r",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
