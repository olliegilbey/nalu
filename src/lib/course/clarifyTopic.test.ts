import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AI SDK so no network call is issued. Asserting wiring:
// schema forwarded, messages include the sanitised topic, result passes through.
const generateObjectMock = vi.fn();

vi.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
  generateText: vi.fn(),
}));

vi.mock("@/lib/llm/provider", () => ({
  getLlmModel: () => ({ __stub: "model" }),
}));

import { clarifyTopic } from "./clarifyTopic";
import { clarifyingQuestionsSchema } from "@/lib/prompts";

beforeEach(() => {
  generateObjectMock.mockReset();
});

describe("clarifyTopic", () => {
  it("forwards the clarifying-questions schema and returns parsed questions + usage", async () => {
    const questions = ["What sub-area?", "Prior experience?"];
    const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };
    generateObjectMock.mockResolvedValueOnce({ object: { questions }, usage });

    const result = await clarifyTopic({ topic: "Rust ownership" });

    expect(result).toEqual({ questions, usage });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0]?.[0] as {
      schema: unknown;
      messages: readonly { role: string; content: string }[];
    };
    expect(call.schema).toBe(clarifyingQuestionsSchema);
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]?.role).toBe("system");
    expect(call.messages[1]?.role).toBe("user");
  });

  it("sanitises the topic inside the user message before dispatch", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { questions: ["a?", "b?"] },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });

    await clarifyTopic({ topic: "<script>alert(1)</script>" });

    const call = generateObjectMock.mock.calls[0]?.[0] as {
      messages: readonly { role: string; content: string }[];
    };
    const userContent = String(call.messages[1]?.content);
    expect(userContent).toContain("<user_message>");
    expect(userContent).toContain("&lt;script&gt;");
    expect(userContent).not.toContain("<script>");
  });

  it("surfaces SDK errors (e.g. schema validation failures)", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("schema mismatch"));
    await expect(clarifyTopic({ topic: "anything" })).rejects.toThrow("schema mismatch");
  });
});
