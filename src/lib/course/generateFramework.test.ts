import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AI SDK so no network call is issued. We're asserting wiring only:
// schema forwarded, topic + answers sanitised before dispatch, result and
// usage propagated unchanged.
const generateObjectMock = vi.fn();

vi.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
  generateText: vi.fn(),
}));

vi.mock("@/lib/llm/provider", () => ({
  getLlmModel: () => ({ __stub: "model" }),
}));

import { generateFramework } from "./generateFramework";
import { frameworkSchema } from "@/lib/prompts";

const sampleFramework = {
  tiers: [
    {
      number: 1,
      name: "Foundations",
      description: "Core concepts.",
      exampleConcepts: ["a", "b", "c", "d"],
    },
    {
      number: 2,
      name: "Intermediate",
      description: "Building blocks.",
      exampleConcepts: ["e", "f", "g", "h"],
    },
    {
      number: 3,
      name: "Advanced",
      description: "Mastery concepts.",
      exampleConcepts: ["i", "j", "k", "l"],
    },
  ],
};

const sampleUsage = { inputTokens: 30, outputTokens: 120, totalTokens: 150 };

beforeEach(() => {
  generateObjectMock.mockReset();
});

describe("generateFramework", () => {
  it("forwards the framework schema and returns parsed framework + usage", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: sampleFramework, usage: sampleUsage });

    const result = await generateFramework({
      topic: "Rust ownership",
      clarifications: [{ question: "Scope?", answer: "Backend services." }],
    });

    expect(result).toEqual({ framework: sampleFramework, usage: sampleUsage });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0]?.[0] as {
      schema: unknown;
      messages: readonly { role: string; content: string }[];
    };
    expect(call.schema).toBe(frameworkSchema);
    // system + topic + clarifications
    expect(call.messages).toHaveLength(3);
    expect(call.messages[0]?.role).toBe("system");
    expect(call.messages[1]?.role).toBe("user");
    expect(call.messages[2]?.role).toBe("user");
  });

  it("sanitises topic and every answer before dispatch", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: sampleFramework, usage: sampleUsage });

    await generateFramework({
      topic: "<script>topic</script>",
      clarifications: [
        { question: "Sub-area?", answer: "<img>" },
        { question: "Level?", answer: "none & new" },
      ],
    });

    const call = generateObjectMock.mock.calls[0]?.[0] as {
      messages: readonly { role: string; content: string }[];
    };
    const topic = String(call.messages[1]?.content);
    const qa = String(call.messages[2]?.content);

    expect(topic).toContain("&lt;script&gt;topic&lt;/script&gt;");
    expect(topic).not.toContain("<script>");

    // Questions appear verbatim, answers HTML-encoded.
    expect(qa).toContain("Sub-area?");
    expect(qa).toContain("Level?");
    expect(qa).toContain("&lt;img&gt;");
    expect(qa).toContain("none &amp; new");
    expect(qa).not.toContain("<img>");
  });

  it("surfaces SDK errors (e.g. schema validation failures)", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("schema mismatch"));
    await expect(
      generateFramework({
        topic: "anything",
        clarifications: [{ question: "q?", answer: "a" }],
      }),
    ).rejects.toThrow("schema mismatch");
  });
});
