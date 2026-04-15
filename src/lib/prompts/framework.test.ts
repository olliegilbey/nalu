import { describe, it, expect } from "vitest";
import { FRAMEWORK } from "@/lib/config/tuning";
import { buildFrameworkPrompt, frameworkSchema } from "./framework";

// Minimal valid framework built from tuning bounds — reused across schema
// assertions so bound changes only edit this one fixture.
function buildValidFramework(tierCount: number) {
  return {
    tiers: Array.from({ length: tierCount }, (_, i) => ({
      number: i + 1,
      name: `Tier ${i + 1}`,
      description: "A short description of what this tier covers.",
      exampleConcepts: Array.from(
        { length: FRAMEWORK.minExampleConceptsPerTier },
        (_, j) => `concept ${j + 1}`,
      ),
    })),
  };
}

describe("buildFrameworkPrompt", () => {
  it("returns system + topic + clarifications in that order", () => {
    const messages = buildFrameworkPrompt({
      topic: "Rust ownership",
      clarifications: [{ question: "Scope?", answer: "Backend services." }],
    });
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[2]?.role).toBe("user");
  });

  it("keeps the system block byte-identical across inputs (cache-friendly)", () => {
    const a = buildFrameworkPrompt({
      topic: "Rust",
      clarifications: [{ question: "q?", answer: "a" }],
    });
    const b = buildFrameworkPrompt({
      topic: "Cooking sourdough",
      clarifications: [
        { question: "q1?", answer: "a1" },
        { question: "q2?", answer: "a2" },
      ],
    });
    expect(a[0]?.content).toBe(b[0]?.content);
  });

  it("system block cites tier bounds and security guidance", () => {
    const [system] = buildFrameworkPrompt({
      topic: "anything",
      clarifications: [{ question: "q?", answer: "a" }],
    });
    const text = String(system?.content);
    // Accepts "3-8", "3 to 8", "3–8".
    expect(text).toMatch(/3.{0,5}8/);
    expect(text.toLowerCase()).toContain("user_message");
    expect(text.toLowerCase()).toContain("data");
  });

  it("wraps the topic via sanitiseUserInput, encoding HTML-dangerous chars", () => {
    const [, topicMsg] = buildFrameworkPrompt({
      topic: "<script>x</script>",
      clarifications: [{ question: "q?", answer: "a" }],
    });
    const text = String(topicMsg?.content);
    expect(text).toContain("<user_message>");
    expect(text).toContain("</user_message>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain("<script>");
  });

  it("sanitises every answer; questions are embedded verbatim", () => {
    const [, , qa] = buildFrameworkPrompt({
      topic: "safe topic",
      clarifications: [
        { question: "What sub-area?", answer: "<img onerror=1>" },
        { question: "Prior experience?", answer: "none & new" },
      ],
    });
    const text = String(qa?.content);
    // Questions appear unmodified (trusted, schema-bounded upstream).
    expect(text).toContain("What sub-area?");
    expect(text).toContain("Prior experience?");
    // Answers are HTML-encoded and wrapped.
    expect(text).toContain("&lt;img onerror=1&gt;");
    expect(text).not.toContain("<img onerror=1>");
    expect(text).toContain("none &amp; new");
    // Each sanitised answer wrapped in its own <user_message> block.
    const openings = text.match(/<user_message>/g) ?? [];
    expect(openings.length).toBe(2);
  });
});

describe("frameworkSchema", () => {
  it("accepts a well-formed framework at the minimum tier count", () => {
    const result = frameworkSchema.safeParse(buildValidFramework(FRAMEWORK.minTiers));
    expect(result.success).toBe(true);
  });

  it("accepts at the maximum tier count", () => {
    const result = frameworkSchema.safeParse(buildValidFramework(FRAMEWORK.maxTiers));
    expect(result.success).toBe(true);
  });

  it("rejects below the minimum tier count", () => {
    const result = frameworkSchema.safeParse(buildValidFramework(FRAMEWORK.minTiers - 1));
    expect(result.success).toBe(false);
  });

  it("rejects above the maximum tier count", () => {
    const result = frameworkSchema.safeParse(buildValidFramework(FRAMEWORK.maxTiers + 1));
    expect(result.success).toBe(false);
  });

  it("rejects non-contiguous tier numbering", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const skewed = {
      tiers: base.tiers.map((t, i) => (i === 0 ? { ...t, number: 99 } : t)),
    };
    expect(frameworkSchema.safeParse(skewed).success).toBe(false);
  });

  it("rejects duplicate tier numbers", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const dup = {
      tiers: base.tiers.map((t) => ({ ...t, number: 1 })),
    };
    expect(frameworkSchema.safeParse(dup).success).toBe(false);
  });

  it("rejects empty example-concept arrays", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const empty = {
      tiers: base.tiers.map((t) => ({ ...t, exampleConcepts: [] })),
    };
    expect(frameworkSchema.safeParse(empty).success).toBe(false);
  });
});
