import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateXP } from "@/lib/scoring/xp";
import {
  formatGradingDebugLine,
  formatParseFailureDebugLine,
  GRADING_DEBUG_CANDIDATE_MAX,
  GRADING_DEBUG_EXCERPT_MAX,
  isGradingDebugEnabled,
  summariseStrippedGradings,
  truncateForDebug,
} from "./gradingDebug";

describe("isGradingDebugEnabled", () => {
  // stubEnv restores both vars after each test, so nothing leaks into siblings.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when the flag is unset (true no-op default)", () => {
    vi.stubEnv("LLM_DEBUG_GRADINGS", undefined);
    expect(isGradingDebugEnabled()).toBe(false);
  });

  it("is false for any value other than exactly '1'", () => {
    vi.stubEnv("LLM_DEBUG_GRADINGS", "true");
    expect(isGradingDebugEnabled()).toBe(false);
    vi.stubEnv("LLM_DEBUG_GRADINGS", "0");
    expect(isGradingDebugEnabled()).toBe(false);
  });

  it.each(["development", "test"])("is true when set to '1' under NODE_ENV=%s", (env) => {
    vi.stubEnv("LLM_DEBUG_GRADINGS", "1");
    vi.stubEnv("NODE_ENV", env);
    expect(isGradingDebugEnabled()).toBe(true);
  });

  it.each([["production"], [undefined], ["staging"]])(
    "fails closed under NODE_ENV=%s, even with the flag on",
    (env) => {
      // Guardrail: learner content must never reach production logs, even
      // when the flag is copied into a production env by mistake. Allowlist,
      // so an unset or unexpected NODE_ENV is refused too.
      vi.stubEnv("LLM_DEBUG_GRADINGS", "1");
      vi.stubEnv("NODE_ENV", env);
      expect(isGradingDebugEnabled()).toBe(false);
    },
  );
});

describe("truncateForDebug", () => {
  it("returns short strings unchanged", () => {
    expect(truncateForDebug("hello", 80)).toBe("hello");
  });

  it("truncates and appends an ellipsis when over the cap", () => {
    const out = truncateForDebug("x".repeat(100), 80);
    expect(out).toBe(`${"x".repeat(80)}…`);
  });

  it("collapses whitespace/newlines to single spaces (one line per grading)", () => {
    expect(truncateForDebug("a\n  b\t c", 80)).toBe("a b c");
  });
});

/** A valid free-text grading; override fields per test. */
const freeText = {
  kind: "free-text",
  questionId: "q3",
  verdict: "correct",
  qualityScore: 5,
  conceptName: "Borrowing",
  conceptTier: 2,
  rationale: "r",
} as const;

describe("formatGradingDebugLine", () => {
  it("shows verdict, quality, XP and the freetext Response for a free-text grading", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      grading: freeText,
      response: { questionId: "q3", freetext: "ownership moves" },
    });
    expect(line).toBe(
      `[grading-debug] wave-close qid="q3" kind=free-text verdict=correct q=5 xp≈${calculateXP(2, 5)} responseKind=freetext response="ownership moves"`,
    );
  });

  it("scores XP at xpTier when given (scoping close uses startingTier)", () => {
    const line = formatGradingDebugLine({
      context: "scoping-close",
      grading: freeText,
      response: undefined,
      xpTier: 3,
    });
    expect(line).toContain(`xp≈${calculateXP(3, 5)}`);
  });

  it("surfaces the zero-XP case (hypothesis 2: q1 → 0 XP)", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      grading: { ...freeText, verdict: "incorrect", qualityScore: 1 },
      response: { questionId: "q3", freetext: "ownership moves" },
    });
    expect(line).toContain("q=1 xp≈0");
  });

  it("keeps qualityScore=0 (present, not dropped as falsy)", () => {
    const line = formatGradingDebugLine({
      context: "scoping-close",
      grading: { ...freeText, verdict: "incorrect", qualityScore: 0 },
      response: undefined,
    });
    expect(line).toContain("q=0 xp≈0");
  });

  it("shows the choice for an mc-index grading of a choice Response, with no mismatch", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      grading: { kind: "mc-index", questionId: "q2", rationale: "r" },
      response: { questionId: "q2", choice: "B" },
    });
    expect(line).toBe(
      '[grading-debug] wave-close qid="q2" kind=mc-index responseKind=choice response="B"',
    );
  });

  it("flags a freetext Response graded mc-index (the silent 0-XP path)", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      grading: { kind: "mc-index", questionId: "q4", rationale: "r" },
      response: { questionId: "q4", freetext: "a correct prose answer" },
    });
    expect(line).toContain("kind=mc-index responseKind=freetext");
    expect(line).toContain('response="a correct prose answer"');
    expect(line).toMatch(/KIND-MISMATCH$/);
  });

  it("flags a choice Response graded free-text", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      grading: freeText,
      response: { questionId: "q3", choice: "A" },
    });
    expect(line).toMatch(/KIND-MISMATCH$/);
  });

  it("says responseKind=none, with no mismatch, when no Response was found", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      grading: freeText,
      response: undefined,
    });
    expect(line).toContain("responseKind=none");
    expect(line).not.toContain("response=");
    expect(line).not.toContain("KIND-MISMATCH");
  });

  it("truncates the Response excerpt to the redaction cap", () => {
    const line = formatGradingDebugLine({
      context: "wave-close",
      grading: freeText,
      response: { questionId: "q3", freetext: "z".repeat(200) },
    });
    expect(line).toContain(`"${"z".repeat(GRADING_DEBUG_EXCERPT_MAX)}…"`);
    expect(line).not.toContain("z".repeat(GRADING_DEBUG_EXCERPT_MAX + 1));
  });
});

describe("summariseStrippedGradings", () => {
  it("names each stripped grading's id and kind", () => {
    const out = summariseStrippedGradings("wave-close", [
      { kind: "free-text", questionId: "q1", verdict: "correct" },
      { kind: "mc-index", questionId: "q2" },
    ]);
    expect(out).toContain("discarding 2 grading(s)");
    expect(out).toContain("q1(free-text)");
    expect(out).toContain("q2(mc-index)");
  });

  it("defensively handles a non-array value (raw pre-parse unknown)", () => {
    expect(summariseStrippedGradings("wave-close", "oops")).toContain("non-array");
  });

  it("tolerates malformed entries without throwing", () => {
    const out = summariseStrippedGradings("wave-close", [null, 42, { questionId: "q9" }]);
    expect(out).toContain("?(?)");
    expect(out).toContain("q9(?)");
  });
});

describe("formatParseFailureDebugLine", () => {
  // Zod's issue-list JSON, as `toValidationGateFailure` puts it on `gate.detail`.
  const detail = JSON.stringify([
    { code: "custom", path: ["gradings"], message: "gradings missing for question ids: q2" },
    { code: "invalid_type", path: ["gradings", 0, "verdict"], message: "Required" },
  ]);

  it("prints Zod issue paths and the gradings fragment, not the leading userMessage", () => {
    const raw = JSON.stringify({
      userMessage: "u".repeat(2000),
      gradings: [{ kind: "free-text", questionId: "q1" }],
    });
    const line = formatParseFailureDebugLine("wave-close", detail, raw);
    expect(line).toContain("label=wave-close");
    expect(line).toContain("gradings: gradings missing for question ids: q2");
    expect(line).toContain("gradings.0.verdict: Required");
    expect(line).toContain('gradings=[{"kind":"free-text","questionId":"q1"}]');
    expect(line).not.toContain("uuuu");
  });

  it("says gradings=absent when the candidate has no gradings key", () => {
    const line = formatParseFailureDebugLine("clarify", detail, JSON.stringify({ a: 1 }));
    expect(line).toMatch(/gradings=absent$/);
  });

  it("falls back to a capped raw prefix when the candidate is not JSON", () => {
    const line = formatParseFailureDebugLine("wave-close", "not json", "x".repeat(1000));
    expect(line).toContain('issues="not json"');
    expect(line).toContain(`candidate="${"x".repeat(GRADING_DEBUG_CANDIDATE_MAX)}…"`);
  });
});
