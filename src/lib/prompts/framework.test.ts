import { describe, it, expect } from "vitest";
import { FRAMEWORK } from "@/lib/config/tuning";
import { buildFrameworkPrompt, frameworkSchema } from "./framework";
import { CLARIFICATION_SYSTEM_PROMPT, buildClarificationPrompt } from "./clarification";

// Minimal valid framework built from tuning bounds — reused across schema
// assertions so bound changes only edit this one fixture.
// Now includes `userMessage` (required by the updated frameworkSchema).
function buildValidFramework(tierCount: number) {
  // Mid-tier estimate with a full three-wide contiguous scope that fits
  // inside `tierCount` for any tierCount ≥ 3 (the minimum). Keeps every
  // positive schema test on a single shape.
  const estimatedStartingTier = Math.min(2, tierCount);
  const scopeLow = Math.max(1, estimatedStartingTier - 1);
  const scopeHigh = Math.min(tierCount, estimatedStartingTier + 1);
  const baselineScopeTiers = Array.from(
    { length: scopeHigh - scopeLow + 1 },
    (_, i) => scopeLow + i,
  );
  return {
    userMessage: "Here's the proficiency ladder I drafted from your answers.",
    tiers: Array.from({ length: tierCount }, (_, i) => ({
      number: i + 1,
      name: `Tier ${i + 1}`,
      description: "A short description of what this tier covers.",
      exampleConcepts: Array.from(
        { length: FRAMEWORK.minExampleConceptsPerTier },
        (_, j) => `concept ${j + 1}`,
      ),
    })),
    estimatedStartingTier,
    baselineScopeTiers,
  };
}

describe("buildFrameworkPrompt", () => {
  it("continues the clarification conversation: sys + topic + assistant + framework-task", () => {
    const messages = buildFrameworkPrompt({
      topic: "Rust ownership",
      clarifications: [{ question: "Scope?", answer: "Backend services." }],
    });
    expect(messages).toHaveLength(4);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[2]?.role).toBe("assistant");
    expect(messages[3]?.role).toBe("user");
  });

  it("the first two messages are byte-identical to the clarification turn (cache prefix)", () => {
    // The scoping phase is a single growing conversation. Each downstream
    // turn MUST share the clarification's leading [system, topic] messages
    // byte-for-byte so prompt-cache prefixes hit.
    const topic = "Rust ownership";
    const clarifyMessages = buildClarificationPrompt({ topic });
    const frameworkMessages = buildFrameworkPrompt({
      topic,
      clarifications: [{ question: "q?", answer: "a" }],
    });
    expect(frameworkMessages[0]?.content).toBe(clarifyMessages[0]?.content);
    expect(frameworkMessages[1]?.content).toBe(clarifyMessages[1]?.content);
  });

  it("the system block is the shared clarification system prompt", () => {
    const [system] = buildFrameworkPrompt({
      topic: "anything",
      clarifications: [{ question: "q?", answer: "a" }],
    });
    expect(system?.content).toBe(CLARIFICATION_SYSTEM_PROMPT);
  });

  it("reconstructs the clarification assistant output from typed Q/A pairs", () => {
    // The assistant message faithfully replays what the model produced on
    // the prior turn (the clarifying questions), so the scoping history is
    // a coherent transcript the model can reason over.
    const [, , assistant] = buildFrameworkPrompt({
      topic: "Rust",
      clarifications: [
        { question: "Scope?", answer: "a" },
        { question: "Goal?", answer: "b" },
      ],
    });
    const parsed = JSON.parse(String(assistant?.content));
    expect(parsed).toEqual({ questions: ["Scope?", "Goal?"] });
  });

  it("the framework-task user message cites tier bounds and scope fields", () => {
    const [, , , taskMsg] = buildFrameworkPrompt({
      topic: "anything",
      clarifications: [{ question: "q?", answer: "a" }],
    });
    const text = String(taskMsg?.content);
    // Accepts "3-8", "3 to 8", "3–8".
    expect(text).toMatch(/3.{0,5}8/);
    expect(text).toContain("estimatedStartingTier");
    expect(text).toContain("baselineScopeTiers");
  });

  it("sanitises every answer; questions are embedded verbatim in the task message", () => {
    const [, , , taskMsg] = buildFrameworkPrompt({
      topic: "safe topic",
      clarifications: [
        { question: "What sub-area?", answer: "<img onerror=1>" },
        { question: "Prior experience?", answer: "none & new" },
      ],
    });
    const text = String(taskMsg?.content);
    // Questions are our own prior output (trusted, schema-bounded upstream)
    // so they appear verbatim.
    expect(text).toContain("What sub-area?");
    expect(text).toContain("Prior experience?");
    // Answers are HTML-encoded and wrapped in <user_message>.
    expect(text).toContain("&lt;img onerror=1&gt;");
    expect(text).not.toContain("<img onerror=1>");
    expect(text).toContain("none &amp; new");
    const openings = text.match(/<user_message>/g) ?? [];
    expect(openings.length).toBe(2);
  });

  it("wraps the topic via sanitiseUserInput inside the shared clarification user turn", () => {
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
      ...base,
      tiers: base.tiers.map((t, i) => (i === 0 ? { ...t, number: 99 } : t)),
    };
    expect(frameworkSchema.safeParse(skewed).success).toBe(false);
  });

  it("rejects duplicate tier numbers", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const dup = {
      ...base,
      tiers: base.tiers.map((t) => ({ ...t, number: 1 })),
    };
    expect(frameworkSchema.safeParse(dup).success).toBe(false);
  });

  it("rejects empty example-concept arrays", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const empty = {
      ...base,
      tiers: base.tiers.map((t) => ({ ...t, exampleConcepts: [] })),
    };
    expect(frameworkSchema.safeParse(empty).success).toBe(false);
  });

  it("rejects estimatedStartingTier outside the produced tier set", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const skew = { ...base, estimatedStartingTier: 99, baselineScopeTiers: [99] };
    expect(frameworkSchema.safeParse(skew).success).toBe(false);
  });

  it("rejects non-contiguous baselineScopeTiers", () => {
    const base = buildValidFramework(FRAMEWORK.maxTiers);
    const skew = { ...base, estimatedStartingTier: 1, baselineScopeTiers: [1, 3] };
    expect(frameworkSchema.safeParse(skew).success).toBe(false);
  });

  it("rejects unsorted / duplicate baselineScopeTiers", () => {
    const base = buildValidFramework(FRAMEWORK.maxTiers);
    const unsorted = { ...base, estimatedStartingTier: 2, baselineScopeTiers: [3, 2] };
    expect(frameworkSchema.safeParse(unsorted).success).toBe(false);
    const dup = { ...base, estimatedStartingTier: 2, baselineScopeTiers: [2, 2] };
    expect(frameworkSchema.safeParse(dup).success).toBe(false);
  });

  it("rejects baselineScopeTiers larger than maxBaselineScopeSize", () => {
    const base = buildValidFramework(FRAMEWORK.maxTiers);
    const tooWide = {
      ...base,
      estimatedStartingTier: 2,
      baselineScopeTiers: Array.from(
        { length: FRAMEWORK.maxBaselineScopeSize + 1 },
        (_, i) => i + 1,
      ),
    };
    expect(frameworkSchema.safeParse(tooWide).success).toBe(false);
  });

  it("rejects baselineScopeTiers that omit estimatedStartingTier", () => {
    const base = buildValidFramework(FRAMEWORK.maxTiers);
    const missing = { ...base, estimatedStartingTier: 3, baselineScopeTiers: [1, 2] };
    expect(frameworkSchema.safeParse(missing).success).toBe(false);
  });

  // userMessage is a required chat-bubble field added in Task 7.
  it("rejects framework without userMessage", () => {
    const { userMessage: _omitted, ...noMsg } = buildValidFramework(FRAMEWORK.minTiers);
    const result = frameworkSchema.safeParse(noMsg);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("userMessage");
    }
  });

  // Refine messages — verify the exact retry-directive text that goes back to the model.
  it("refine: tier count below minimum emits correct message", () => {
    const result = frameworkSchema.safeParse(buildValidFramework(FRAMEWORK.minTiers - 1));
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => /tiers must contain between/.test(m))).toBe(true);
    }
  });

  it("refine: tier count above maximum emits correct message", () => {
    const result = frameworkSchema.safeParse(buildValidFramework(FRAMEWORK.maxTiers + 1));
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => /tiers must contain between/.test(m))).toBe(true);
    }
  });

  it("refine: non-contiguous tier numbers emits correct message", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const skewed = {
      ...base,
      tiers: base.tiers.map((t, i) => (i === 0 ? { ...t, number: 99 } : t)),
    };
    const result = frameworkSchema.safeParse(skewed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => /tier numbers must be contiguous starting at 1/.test(m))).toBe(true);
    }
  });

  it("refine: exampleConcepts below minimum emits correct message", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const tooFew = {
      ...base,
      tiers: base.tiers.map((t) => ({ ...t, exampleConcepts: [] })),
    };
    const result = frameworkSchema.safeParse(tooFew);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => /exampleConcepts must contain between/.test(m))).toBe(true);
    }
  });

  it("superRefine: baselineScopeTiers must be contiguous emits correct message", () => {
    const base = buildValidFramework(FRAMEWORK.maxTiers);
    const skew = { ...base, estimatedStartingTier: 1, baselineScopeTiers: [1, 3] };
    const result = frameworkSchema.safeParse(skew);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => /baselineScopeTiers must be contiguous/.test(m))).toBe(true);
    }
  });

  it("superRefine: baselineScopeTiers unsorted emits correct message", () => {
    const base = buildValidFramework(FRAMEWORK.maxTiers);
    const unsorted = { ...base, estimatedStartingTier: 2, baselineScopeTiers: [3, 2] };
    const result = frameworkSchema.safeParse(unsorted);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => /baselineScopeTiers must be sorted ascending with no duplicates/.test(m)),
      ).toBe(true);
    }
  });

  it("superRefine: estimatedStartingTier outside tier set emits correct message", () => {
    const base = buildValidFramework(FRAMEWORK.minTiers);
    const skew = { ...base, estimatedStartingTier: 99, baselineScopeTiers: [99] };
    const result = frameworkSchema.safeParse(skew);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => /estimatedStartingTier must be one of the produced tier numbers/.test(m)),
      ).toBe(true);
    }
  });
});
