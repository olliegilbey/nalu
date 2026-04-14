import { describe, it, expect } from "vitest";
import { buildClarificationPrompt, clarifyingQuestionsSchema } from "./clarification";

describe("buildClarificationPrompt", () => {
  it("returns a system message followed by a user message", () => {
    const messages = buildClarificationPrompt({ topic: "Rust ownership" });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
  });

  it("keeps the system block stable across different topics (cache-friendly)", () => {
    // Static block must be byte-identical regardless of topic so the prompt
    // prefix is cache-reusable once providers support it.
    const a = buildClarificationPrompt({ topic: "Rust" });
    const b = buildClarificationPrompt({ topic: "Cooking sourdough" });
    expect(a[0]?.content).toBe(b[0]?.content);
  });

  it("system block instructs 2–4 questions and contains security guidance", () => {
    const [system] = buildClarificationPrompt({ topic: "anything" });
    const text = String(system?.content);
    expect(text).toMatch(/2.{0,5}4/); // tolerates "2-4", "2 to 4", "2–4"
    expect(text.toLowerCase()).toContain("user_message");
    expect(text.toLowerCase()).toContain("data");
  });

  it("wraps the topic via sanitiseUserInput in the user message", () => {
    const [, user] = buildClarificationPrompt({ topic: "<script>x</script>" });
    const text = String(user?.content);
    expect(text).toContain("<user_message>");
    expect(text).toContain("</user_message>");
    // Raw angle brackets from the topic must be encoded.
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain("<script>");
  });

  it("preserves benign topic text inside the wrapper", () => {
    const [, user] = buildClarificationPrompt({ topic: "Rust ownership" });
    expect(String(user?.content)).toContain("Rust ownership");
  });
});

describe("clarifyingQuestionsSchema", () => {
  it("accepts 2 to 4 non-empty questions", () => {
    expect(clarifyingQuestionsSchema.safeParse({ questions: ["a?", "b?"] }).success).toBe(true);
    expect(
      clarifyingQuestionsSchema.safeParse({
        questions: ["a?", "b?", "c?", "d?"],
      }).success,
    ).toBe(true);
  });

  it("rejects fewer than 2 or more than 4 questions", () => {
    expect(clarifyingQuestionsSchema.safeParse({ questions: ["only one?"] }).success).toBe(false);
    expect(
      clarifyingQuestionsSchema.safeParse({
        questions: ["a?", "b?", "c?", "d?", "e?"],
      }).success,
    ).toBe(false);
  });

  it("rejects empty-string questions", () => {
    expect(clarifyingQuestionsSchema.safeParse({ questions: ["", "valid?"] }).success).toBe(false);
  });
});
