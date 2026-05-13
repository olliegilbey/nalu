import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatHeader,
  formatParseFailure,
  formatParseSuccess,
  formatPromptBlock,
  formatResponseBlock,
  isLive,
  isQuiet,
} from "./formatTurn";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";

/**
 * These are pure-string assertions — we never touch real stderr.
 * Color is automatically off in vitest (stderr is not a TTY here), so
 * the output is plain ASCII and stable to grep on.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLive / isQuiet", () => {
  test("isLive true only when CEREBRAS_LIVE=1", () => {
    vi.stubEnv("CEREBRAS_LIVE", "1");
    expect(isLive()).toBe(true);
    vi.stubEnv("CEREBRAS_LIVE", "0");
    expect(isLive()).toBe(false);
  });
  test("isQuiet true only when NALU_SMOKE_QUIET=1", () => {
    vi.stubEnv("NALU_SMOKE_QUIET", "1");
    expect(isQuiet()).toBe(true);
    vi.stubEnv("NALU_SMOKE_QUIET", "");
    expect(isQuiet()).toBe(false);
  });
});

describe("formatHeader", () => {
  test("includes label, attempt counts, model and topic", () => {
    const out = formatHeader({
      label: "clarify",
      attempt: 2,
      totalAttempts: 3,
      model: "llama3.1-8b",
      topic: "sourdough starter",
    });
    expect(out).toContain("clarify");
    expect(out).toContain("2/3");
    expect(out).toContain("llama3.1-8b");
    // Topic is JSON-quoted so it survives multi-word topics legibly.
    expect(out).toContain('"sourdough starter"');
    // Box drawing bar should bracket the line.
    expect(out).toContain("━");
  });
});

describe("formatPromptBlock", () => {
  test("renders each message with a role separator", () => {
    const out = formatPromptBlock([
      { role: "system", content: "SYSTEM_TEXT" },
      { role: "user", content: "USER_TEXT" },
    ]);
    expect(out).toContain("─── system ───");
    expect(out).toContain("SYSTEM_TEXT");
    expect(out).toContain("─── user ───");
    expect(out).toContain("USER_TEXT");
  });
});

describe("formatResponseBlock", () => {
  test("includes timing and token usage", () => {
    const out = formatResponseBlock("RAW_BODY", 842, {
      inputTokens: 412,
      outputTokens: 287,
      totalTokens: 699,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    });
    expect(out).toContain("RAW_BODY");
    expect(out).toContain("842ms");
    expect(out).toContain("412 in / 287 out");
  });
});

describe("formatParseSuccess / formatParseFailure", () => {
  test("success includes label and summary", () => {
    const out = formatParseSuccess("clarify", "questions=3");
    expect(out).toContain("parse OK");
    expect(out).toContain("clarify");
    expect(out).toContain("questions=3");
  });
  test("failure surfaces reason, diagnosis and retry directive verbatim", () => {
    const err = new ValidationGateFailure(
      "missing_response",
      "Your <baseline> payload failed schema validation: foo.",
    );
    const out = formatParseFailure("baseline", err, "diagnosis-text");
    expect(out).toContain("parse FAILED");
    expect(out).toContain("baseline");
    expect(out).toContain("missing_response");
    expect(out).toContain("diagnosis-text");
    // Directive content preserved exactly so the reader sees what the model sees.
    expect(out).toContain("Your <baseline> payload failed schema validation: foo.");
  });
});
