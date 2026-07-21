import { afterEach, describe, expect, it } from "vitest";
import {
  formatGradingDebugLine,
  GRADING_DEBUG_EXCERPT_MAX,
  isGradingDebugEnabled,
  summariseStrippedGradings,
  truncateForDebug,
} from "./gradingDebug";

describe("isGradingDebugEnabled", () => {
  const original = process.env.LLM_DEBUG_GRADINGS;
  afterEach(() => {
    // Restore so tests can't leak the flag into siblings.
    if (original === undefined) delete process.env.LLM_DEBUG_GRADINGS;
    else process.env.LLM_DEBUG_GRADINGS = original;
  });

  it("is false when the flag is unset (true no-op default)", () => {
    delete process.env.LLM_DEBUG_GRADINGS;
    expect(isGradingDebugEnabled()).toBe(false);
  });

  it("is false for any value other than exactly '1'", () => {
    process.env.LLM_DEBUG_GRADINGS = "true";
    expect(isGradingDebugEnabled()).toBe(false);
    process.env.LLM_DEBUG_GRADINGS = "0";
    expect(isGradingDebugEnabled()).toBe(false);
  });

  it("is true only when set to '1'", () => {
    process.env.LLM_DEBUG_GRADINGS = "1";
    expect(isGradingDebugEnabled()).toBe(true);
  });
});

describe("truncateForDebug", () => {
  it("returns short strings unchanged", () => {
    expect(truncateForDebug("hello", 80)).toBe("hello");
  });

  it("truncates and appends an ellipsis when over the cap", () => {
    const long = "x".repeat(100);
    const out = truncateForDebug(long, 80);
    expect(out).toBe(`${"x".repeat(80)}…`);
    // The ellipsis is one extra char beyond the cap; the payload itself is capped.
    expect(out.slice(0, 80)).toBe("x".repeat(80));
  });

  it("collapses whitespace/newlines to single spaces (one line per grading)", () => {
    expect(truncateForDebug("a\n  b\t c", 80)).toBe("a b c");
  });

  it("caps at exactly GRADING_DEBUG_EXCERPT_MAX chars of payload", () => {
    const out = truncateForDebug("y".repeat(200), GRADING_DEBUG_EXCERPT_MAX);
    expect(out.replace("…", "")).toHaveLength(GRADING_DEBUG_EXCERPT_MAX);
  });
});

describe("formatGradingDebugLine", () => {
  it("includes verdict, qualityScore, and computed XP for free-text", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      questionId: "q3",
      kind: "free-text",
      verdict: "correct",
      qualityScore: 5,
      computedXp: 75,
    });
    expect(line).toContain("[grading-debug]");
    expect(line).toContain("wave-close");
    expect(line).toContain('qid="q3"');
    expect(line).toContain("kind=free-text");
    expect(line).toContain("verdict=correct");
    expect(line).toContain("q=5");
    expect(line).toContain("xp≈75");
  });

  it("surfaces the zero-XP case (hypothesis 2: correct-looking answer, q1 → 0 XP)", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      questionId: "q1",
      kind: "free-text",
      verdict: "incorrect",
      qualityScore: 1,
      computedXp: 0,
    });
    expect(line).toContain("q=1");
    expect(line).toContain("xp≈0");
  });

  it("stays compact for mc-index (no verdict/quality/xp/answer)", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      questionId: "q2",
      kind: "mc-index",
    });
    expect(line).toBe('[grading-debug] wave-close qid="q2" kind=mc-index');
    expect(line).not.toContain("verdict");
    expect(line).not.toContain("xp≈");
  });

  it("truncates the learner answer excerpt to the redaction cap", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      questionId: "q4",
      kind: "free-text",
      answerExcerpt: "z".repeat(200),
    });
    // The excerpt is JSON-quoted; the payload inside must be capped + ellipsis.
    expect(line).toContain(`${"z".repeat(GRADING_DEBUG_EXCERPT_MAX)}…`);
    expect(line).not.toContain("z".repeat(GRADING_DEBUG_EXCERPT_MAX + 1));
  });

  it("omits qualityScore=0 correctly (present, not dropped as falsy)", () => {
    const line = formatGradingDebugLine({
      context: "scoping-close",
      questionId: "q0",
      kind: "free-text",
      qualityScore: 0,
      computedXp: 0,
    });
    expect(line).toContain("q=0");
    expect(line).toContain("xp≈0");
  });
});

describe("summariseStrippedGradings", () => {
  it("names each stripped grading's id and kind", () => {
    const out = summariseStrippedGradings("strip", [
      { kind: "free-text", questionId: "q1", verdict: "correct" },
      { kind: "mc-index", questionId: "q2" },
    ]);
    expect(out).toContain("discarding 2 grading(s)");
    expect(out).toContain("q1(free-text)");
    expect(out).toContain("q2(mc-index)");
  });

  it("defensively handles a non-array value (raw pre-parse unknown)", () => {
    expect(summariseStrippedGradings("strip", "oops")).toContain("non-array");
  });

  it("tolerates malformed entries without throwing", () => {
    const out = summariseStrippedGradings("strip", [null, 42, { questionId: "q9" }]);
    expect(out).toContain("?(?)");
    expect(out).toContain("q9(?)");
  });
});
