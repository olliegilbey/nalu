import { describe, it, expect, vi, beforeEach } from "vitest";
import { BASELINE, PROGRESSION, FRAMEWORK } from "@/lib/config/tuning";
import { FREETEXT_ESCAPE_PREFIX } from "@/lib/prompts";
import type { BaselineAssessment, BaselineQuestion, Framework } from "@/lib/prompts";

// Mock the AI SDK so no network call fires. The LLM batch path is exercised
// by inspecting the call args and returning canned evaluations.
const generateObjectMock = vi.fn();

vi.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
  generateText: vi.fn(),
}));

vi.mock("@/lib/llm/provider", () => ({
  getLlmModel: () => ({ __stub: "model" }),
}));

import { gradeBaseline, type BaselineAnswer } from "./gradeBaseline";
import { baselineEvaluationSchema } from "@/lib/prompts";

beforeEach(() => {
  generateObjectMock.mockReset();
});

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

function mc(id: string, tier: number, correct: "A" | "B" | "C" | "D" = "A"): BaselineQuestion {
  return {
    id,
    tier,
    conceptName: `concept-${id}`,
    type: "multiple_choice",
    question: `q-${id}?`,
    options: { A: "a", B: "b", C: "c", D: "d" },
    correct,
    freetextRubric: `rubric-${id}`,
  };
}

function ft(id: string, tier: number): BaselineQuestion {
  return {
    id,
    tier,
    conceptName: `concept-${id}`,
    type: "free_text",
    question: `q-${id}?`,
    freetextRubric: `rubric-${id}`,
  };
}

function baseline(questions: readonly BaselineQuestion[]): BaselineAssessment {
  return { questions: [...questions] } as BaselineAssessment;
}

const baseParams = {
  topic: "Rust ownership",
  clarifications: [{ question: "q?", answer: "a" }],
  framework: validFramework(),
};

describe("gradeBaseline — mechanical MC path", () => {
  it("grades a correct MC click at BASELINE.mcCorrectQuality, no LLM call", async () => {
    const questions = [mc("b1", 1, "A")];
    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "A" }];

    const result = await gradeBaseline({
      ...baseParams,
      baseline: baseline(questions),
      answers,
    });

    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(result.gradings).toHaveLength(1);
    expect(result.gradings[0]?.quality).toBe(BASELINE.mcCorrectQuality);
    expect(result.gradings[0]?.isCorrect).toBe(true);
    // Zero-filled usage (no LLM call). We check the semantically meaningful
    // fields rather than the full LanguageModelUsage shape — the detail
    // sub-objects are plumbing the AI SDK requires but don't matter here.
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
  });

  it("grades an incorrect MC click at BASELINE.mcIncorrectQuality, no LLM call", async () => {
    const questions = [mc("b1", 1, "A")];
    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "B" }];

    const result = await gradeBaseline({
      ...baseParams,
      baseline: baseline(questions),
      answers,
    });

    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(result.gradings[0]?.quality).toBe(BASELINE.mcIncorrectQuality);
    // mcIncorrectQuality=1 < passingQualityScore=3 → isCorrect must be false.
    expect(result.gradings[0]?.isCorrect).toBe(
      BASELINE.mcIncorrectQuality >= PROGRESSION.passingQualityScore,
    );
    expect(result.gradings[0]?.isCorrect).toBe(false);
  });

  it("propagates conceptName and tier from the question, not the answer", async () => {
    const questions = [mc("b1", 2, "C")];
    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "C" }];

    const result = await gradeBaseline({
      ...baseParams,
      baseline: baseline(questions),
      answers,
    });

    expect(result.gradings[0]?.conceptName).toBe("concept-b1");
    expect(result.gradings[0]?.tier).toBe(2);
  });
});

describe("gradeBaseline — LLM batch path", () => {
  it("routes a native free-text answer to the grader with viaEscape: false", async () => {
    const questions = [ft("b1", 1)];
    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "my answer", fromEscape: false },
    ];
    generateObjectMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          {
            questionId: "b1",
            conceptName: "concept-b1",
            qualityScore: 4,
            isCorrect: true,
            rationale: "ok",
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const result = await gradeBaseline({
      ...baseParams,
      baseline: baseline(questions),
      answers,
    });

    const call = generateObjectMock.mock.calls[0]?.[0] as {
      schema: unknown;
      messages: readonly { role: string; content: string }[];
    };
    expect(call.schema).toBe(baselineEvaluationSchema);
    const gradingTask = String(call.messages[call.messages.length - 1]?.content);
    expect(gradingTask).toContain("viaEscape: false");
    expect(gradingTask).not.toContain(FREETEXT_ESCAPE_PREFIX);

    expect(result.gradings[0]?.quality).toBe(4);
    expect(result.gradings[0]?.isCorrect).toBe(true);
    expect(result.gradings[0]?.rationale).toBe("ok");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("freetext-escape on an MC question prepends the P-AC-03 prefix in the grader prompt", async () => {
    const questions = [mc("b1", 1, "A")];
    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "not sure", fromEscape: true },
    ];
    generateObjectMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          {
            questionId: "b1",
            conceptName: "concept-b1",
            qualityScore: 0,
            isCorrect: false,
            rationale: "non-engagement",
          },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    await gradeBaseline({
      ...baseParams,
      baseline: baseline(questions),
      answers,
    });

    const call = generateObjectMock.mock.calls[0]?.[0] as {
      messages: readonly { role: string; content: string }[];
    };
    const gradingTask = String(call.messages[call.messages.length - 1]?.content);
    expect(gradingTask).toContain("viaEscape: true");
    expect(gradingTask).toContain(FREETEXT_ESCAPE_PREFIX);
  });

  it("partitions a mixed batch: MC clicks mechanical, free-text + escape go to the LLM", async () => {
    const questions = [
      mc("b1", 1, "A"),
      mc("b2", 1, "B"), // answered via escape → LLM
      ft("b3", 2), // native free-text → LLM
    ];
    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "mc", selected: "A" },
      { id: "b2", kind: "freetext", text: "guess", fromEscape: true },
      { id: "b3", kind: "freetext", text: "real answer", fromEscape: false },
    ];
    generateObjectMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          {
            questionId: "b3",
            conceptName: "concept-b3",
            qualityScore: 3,
            isCorrect: true,
            rationale: "ok",
          },
          {
            questionId: "b2",
            conceptName: "concept-b2",
            qualityScore: 2,
            isCorrect: false,
            rationale: "partial",
          },
        ],
      },
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });

    const result = await gradeBaseline({
      ...baseParams,
      baseline: baseline(questions),
      answers,
    });

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0]?.[0] as {
      messages: readonly { role: string; content: string }[];
    };
    const gradingTask = String(call.messages[call.messages.length - 1]?.content);
    // Only b2 and b3 routed to LLM — b1 (MC click) is mechanical.
    expect(gradingTask).toContain("questionId: b2");
    expect(gradingTask).toContain("questionId: b3");
    expect(gradingTask).not.toContain("questionId: b1");

    // Merge preserves question-array order (b1, b2, b3), not answer order or
    // grader-response order (b3, b2).
    expect(result.gradings.map((g) => g.questionId)).toEqual(["b1", "b2", "b3"]);
    expect(result.gradings[0]?.quality).toBe(BASELINE.mcCorrectQuality);
    expect(result.gradings[1]?.quality).toBe(2);
    expect(result.gradings[2]?.quality).toBe(3);
  });
});

describe("gradeBaseline — input invariants", () => {
  it("throws on an answer for an unknown question id", async () => {
    const questions = [mc("b1", 1, "A")];
    const answers: BaselineAnswer[] = [{ id: "b9", kind: "mc", selected: "A" }];
    await expect(
      gradeBaseline({ ...baseParams, baseline: baseline(questions), answers }),
    ).rejects.toThrow(/unknown question id/);
  });

  it("throws on duplicate answers for the same question", async () => {
    const questions = [mc("b1", 1, "A")];
    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "mc", selected: "A" },
      { id: "b1", kind: "mc", selected: "B" },
    ];
    await expect(
      gradeBaseline({ ...baseParams, baseline: baseline(questions), answers }),
    ).rejects.toThrow(/duplicate answer/);
  });

  it("throws when a question has no answer", async () => {
    const questions = [mc("b1", 1, "A"), mc("b2", 1, "A")];
    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "A" }];
    await expect(
      gradeBaseline({ ...baseParams, baseline: baseline(questions), answers }),
    ).rejects.toThrow(/no answer provided/);
  });

  it("throws when an MC answer is submitted for a free_text question", async () => {
    const questions = [ft("b1", 1)];
    const answers: BaselineAnswer[] = [{ id: "b1", kind: "mc", selected: "A" }];
    await expect(
      gradeBaseline({ ...baseParams, baseline: baseline(questions), answers }),
    ).rejects.toThrow(/mc answer submitted for free_text/);
  });
});

describe("gradeBaseline — LLM response invariants", () => {
  it("throws when the grader returns an evaluation for an unsubmitted questionId", async () => {
    const questions = [ft("b1", 1)];
    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "x", fromEscape: false },
    ];
    generateObjectMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          {
            questionId: "b9",
            conceptName: "c",
            qualityScore: 3,
            isCorrect: true,
            rationale: "r",
          },
        ],
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    await expect(
      gradeBaseline({ ...baseParams, baseline: baseline(questions), answers }),
    ).rejects.toThrow(/unsubmitted question id/);
  });

  it("throws when the grader returns a duplicate evaluation for the same questionId", async () => {
    const questions = [ft("b1", 1)];
    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "x", fromEscape: false },
    ];
    const evalRow = {
      questionId: "b1",
      conceptName: "c",
      qualityScore: 3,
      isCorrect: true,
      rationale: "r",
    };
    generateObjectMock.mockResolvedValueOnce({
      object: { evaluations: [evalRow, evalRow] },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    await expect(
      gradeBaseline({ ...baseParams, baseline: baseline(questions), answers }),
    ).rejects.toThrow(/duplicate evaluation/);
  });

  it("throws when the grader omits a submitted questionId", async () => {
    const questions = [ft("b1", 1), ft("b2", 1)];
    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "x", fromEscape: false },
      { id: "b2", kind: "freetext", text: "y", fromEscape: false },
    ];
    generateObjectMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          {
            questionId: "b1",
            conceptName: "c",
            qualityScore: 3,
            isCorrect: true,
            rationale: "r",
          },
        ],
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    await expect(
      gradeBaseline({ ...baseParams, baseline: baseline(questions), answers }),
    ).rejects.toThrow(/omitted evaluations/);
  });

  it("surfaces SDK errors from the grader call", async () => {
    const questions = [ft("b1", 1)];
    const answers: BaselineAnswer[] = [
      { id: "b1", kind: "freetext", text: "x", fromEscape: false },
    ];
    generateObjectMock.mockRejectedValueOnce(new Error("schema mismatch"));
    await expect(
      gradeBaseline({ ...baseParams, baseline: baseline(questions), answers }),
    ).rejects.toThrow("schema mismatch");
  });
});
