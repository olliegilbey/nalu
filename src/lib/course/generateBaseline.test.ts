import { describe, it, expect, vi, beforeEach } from "vitest";
import { FRAMEWORK } from "@/lib/config/tuning";
import type { Framework } from "@/lib/prompts";

// Mock the AI SDK so no network call is issued. Asserting wiring: schema
// forwarded, full scoping history in messages, invariants post-checked.
const generateObjectMock = vi.fn();

vi.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
  generateText: vi.fn(),
}));

vi.mock("@/lib/llm/provider", () => ({
  getLlmModel: () => ({ __stub: "model" }),
}));

import { generateBaseline } from "./generateBaseline";
import { baselineSchema } from "@/lib/prompts";

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
    baselineScopeTiers: tiers.map((t) => t.number).slice(0, FRAMEWORK.maxBaselineScopeSize),
  } as Framework;
}

function mcQuestion(id: string, tier: number) {
  return {
    id,
    tier,
    conceptName: "c",
    type: "multiple_choice" as const,
    question: "q?",
    options: { A: "a", B: "b", C: "c", D: "d" },
    correct: "A" as const,
    freetextRubric: "rubric",
  };
}

describe("generateBaseline", () => {
  it("forwards the baseline schema and returns questions, scope, usage", async () => {
    const questions = [
      mcQuestion("b1", 1),
      mcQuestion("b2", 1),
      mcQuestion("b3", 1),
      mcQuestion("b4", 2),
      mcQuestion("b5", 2),
      mcQuestion("b6", 2),
      mcQuestion("b7", 3),
    ];
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    generateObjectMock.mockResolvedValueOnce({ object: { questions }, usage });

    const result = await generateBaseline({
      topic: "Rust ownership",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
    });

    expect(result.questions).toEqual(questions);
    expect(result.scopeTiers).toEqual([1, 2, 3]);
    expect(result.estimatedStartingTier).toBe(2);
    expect(result.usage).toEqual(usage);

    const call = generateObjectMock.mock.calls[0]?.[0] as {
      schema: unknown;
      messages: readonly { role: string; content: string }[];
    };
    expect(call.schema).toBe(baselineSchema);
    // Full scoping history: sys + topic + clarification-assistant +
    // framework-task + framework-assistant + baseline-task.
    expect(call.messages).toHaveLength(6);
    expect(call.messages[0]?.role).toBe("system");
    expect(call.messages[5]?.role).toBe("user");
  });

  it("sanitises the topic inside the shared clarification user message", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        questions: Array.from({ length: 7 }, (_, i) => mcQuestion(`b${i + 1}`, 1)),
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });

    await generateBaseline({
      topic: "<script>alert(1)</script>",
      clarifications: [{ question: "q?", answer: "a" }],
      framework: validFramework(),
    });

    const call = generateObjectMock.mock.calls[0]?.[0] as {
      messages: readonly { role: string; content: string }[];
    };
    const topicMsg = String(call.messages[1]?.content);
    expect(topicMsg).toContain("&lt;script&gt;");
    expect(topicMsg).not.toContain("<script>");
  });

  it("rejects a response whose question tier is outside baselineScopeTiers", async () => {
    // Scope is [1,2,3]; tier=4 violates P-ON-02 and must fail loud.
    const questions = [
      mcQuestion("b1", 1),
      mcQuestion("b2", 1),
      mcQuestion("b3", 1),
      mcQuestion("b4", 2),
      mcQuestion("b5", 2),
      mcQuestion("b6", 2),
      mcQuestion("b7", 4),
    ];
    generateObjectMock.mockResolvedValueOnce({
      object: { questions },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });

    await expect(
      generateBaseline({
        topic: "Rust",
        clarifications: [{ question: "q?", answer: "a" }],
        framework: validFramework(),
      }),
    ).rejects.toThrow(/outside baselineScopeTiers/);
  });

  it("rejects duplicate question ids", async () => {
    const questions = [
      mcQuestion("b1", 1),
      mcQuestion("b2", 1),
      mcQuestion("b3", 1),
      mcQuestion("b4", 2),
      mcQuestion("b5", 2),
      mcQuestion("b6", 2),
      mcQuestion("b6", 3), // duplicate id
    ];
    generateObjectMock.mockResolvedValueOnce({
      object: { questions },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });

    await expect(
      generateBaseline({
        topic: "Rust",
        clarifications: [{ question: "q?", answer: "a" }],
        framework: validFramework(),
      }),
    ).rejects.toThrow(/not unique/);
  });

  it("surfaces SDK errors (e.g. schema validation failures)", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("schema mismatch"));
    await expect(
      generateBaseline({
        topic: "Rust",
        clarifications: [{ question: "q?", answer: "a" }],
        framework: validFramework(),
      }),
    ).rejects.toThrow("schema mismatch");
  });
});
