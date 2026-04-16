import { describe, it, expect } from "vitest";
import { BASELINE, FRAMEWORK } from "@/lib/config/tuning";
import { buildBaselinePrompt, baselineSchema } from "./baseline";
import { buildFrameworkPrompt, type Framework } from "./framework";

/**
 * Minimal framework fixture satisfying `frameworkSchema`. Produced from
 * `tuning.FRAMEWORK` so bound changes only touch one fixture. We don't
 * route through `frameworkSchema.parse` — the baseline module trusts
 * framework input (it's our own prior output).
 */
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

function baseMc(id: string, tier: number) {
  return {
    id,
    tier,
    conceptName: "concept",
    type: "multiple_choice" as const,
    question: "q?",
    options: { A: "a", B: "b", C: "c", D: "d" },
    correct: "A" as const,
    freetextRubric: "rubric",
  };
}

function baseFt(id: string, tier: number) {
  return {
    id,
    tier,
    conceptName: "concept",
    type: "free_text" as const,
    question: "q?",
    freetextRubric: "rubric",
  };
}

function buildQuestions(count: number) {
  return Array.from({ length: count }, (_, i) => baseMc(`b${i + 1}`, 1));
}

describe("buildBaselinePrompt", () => {
  it("continues the framework conversation: 6 messages, alternating user/assistant after the system block", () => {
    const messages = buildBaselinePrompt({
      topic: "Rust ownership",
      clarifications: [{ question: "Scope?", answer: "backend" }],
      framework: validFramework(),
    });
    expect(messages).toHaveLength(6);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user"); // topic
    expect(messages[2]?.role).toBe("assistant"); // clarification output
    expect(messages[3]?.role).toBe("user"); // framework-task
    expect(messages[4]?.role).toBe("assistant"); // framework output
    expect(messages[5]?.role).toBe("user"); // baseline-task
  });

  it("the leading messages are byte-identical to the framework turn (cache prefix)", () => {
    // The scoping phase is a single growing conversation. The baseline
    // turn MUST reuse the framework turn's full message array verbatim so
    // downstream turns share as long a cache prefix as possible.
    const topic = "Rust ownership";
    const clarifications = [{ question: "q?", answer: "a" }];
    const fw = validFramework();
    const frameworkMessages = buildFrameworkPrompt({ topic, clarifications });
    const baselineMessages = buildBaselinePrompt({
      topic,
      clarifications,
      framework: fw,
    });
    frameworkMessages.forEach((m, i) => {
      expect(baselineMessages[i]?.content).toBe(m.content);
      expect(baselineMessages[i]?.role).toBe(m.role);
    });
  });

  it("the framework assistant message is the framework JSON", () => {
    const fw = validFramework();
    const messages = buildBaselinePrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: fw,
    });
    const assistant = messages[4];
    expect(assistant?.role).toBe("assistant");
    expect(JSON.parse(String(assistant?.content))).toEqual(fw);
  });

  it("the baseline-task user message names the estimated tier and scope tiers", () => {
    const fw: Framework = {
      ...validFramework(),
      estimatedStartingTier: 2,
      baselineScopeTiers: [1, 2, 3],
    };
    const messages = buildBaselinePrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: fw,
    });
    const text = String(messages[5]?.content);
    expect(text).toContain("estimated starting tier is 2");
    expect(text).toContain("[1, 2, 3]");
  });

  it("baseline-task user message contains P-ON-03 standalone rule and P-AC-02 no-'Not sure'", () => {
    const messages = buildBaselinePrompt({
      topic: "anything",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
    });
    const text = String(messages[5]?.content).toLowerCase();
    expect(text).toContain("standalone");
    expect(text).toContain("not sure");
  });

  it("baseline-task user message states question-count bounds", () => {
    const messages = buildBaselinePrompt({
      topic: "anything",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
    });
    const text = String(messages[5]?.content);
    expect(text).toContain(String(BASELINE.minQuestions));
    expect(text).toContain(String(BASELINE.maxQuestions));
  });
});

describe("baselineSchema", () => {
  it("accepts a well-formed MC + free-text mix at minQuestions", () => {
    const questions = [
      baseMc("b1", 1),
      baseFt("b2", 1),
      ...Array.from({ length: BASELINE.minQuestions - 2 }, (_, i) => baseMc(`b${i + 3}`, 2)),
    ];
    expect(baselineSchema.safeParse({ questions }).success).toBe(true);
  });

  it("accepts at maxQuestions", () => {
    expect(
      baselineSchema.safeParse({ questions: buildQuestions(BASELINE.maxQuestions) }).success,
    ).toBe(true);
  });

  it("rejects below minQuestions", () => {
    expect(
      baselineSchema.safeParse({ questions: buildQuestions(BASELINE.minQuestions - 1) }).success,
    ).toBe(false);
  });

  it("rejects above maxQuestions", () => {
    expect(
      baselineSchema.safeParse({ questions: buildQuestions(BASELINE.maxQuestions + 1) }).success,
    ).toBe(false);
  });

  it("rejects an MC question missing the rubric", () => {
    // Pick the allowed fields explicitly instead of `delete`ing the rubric
    // off a copy — keeps the `functional/immutable-data` rule happy without
    // an unused-var binding from destructuring.
    const full = baseMc("b1", 1);
    const q = {
      id: full.id,
      tier: full.tier,
      conceptName: full.conceptName,
      type: full.type,
      question: full.question,
      options: full.options,
      correct: full.correct,
    };
    const questions = [q, ...buildQuestions(BASELINE.minQuestions - 1)];
    expect(baselineSchema.safeParse({ questions }).success).toBe(false);
  });

  it("rejects `correct` outside A/B/C/D", () => {
    const bad = { ...baseMc("b1", 1), correct: "E" };
    const questions = [bad, ...buildQuestions(BASELINE.minQuestions - 1)];
    expect(baselineSchema.safeParse({ questions }).success).toBe(false);
  });

  it("rejects a question id that isn't the b<number> pattern", () => {
    const bad = { ...baseMc("nope", 1) };
    const questions = [bad, ...buildQuestions(BASELINE.minQuestions - 1)];
    expect(baselineSchema.safeParse({ questions }).success).toBe(false);
  });

  it("rejects empty question text", () => {
    const bad = { ...baseMc("b1", 1), question: "" };
    const questions = [bad, ...buildQuestions(BASELINE.minQuestions - 1)];
    expect(baselineSchema.safeParse({ questions }).success).toBe(false);
  });
});
