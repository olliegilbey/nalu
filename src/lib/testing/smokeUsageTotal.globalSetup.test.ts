import { describe, it, expect } from "vitest";
import { addUsageTotals } from "./smokeUsageTotal.globalSetup";

describe("addUsageTotals", () => {
  it("adds two totals field by field (summing smoke files)", () => {
    const a = {
      steps: 1,
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 7,
      reasoningTokens: 0,
    };
    const b = {
      steps: 2,
      inputTokens: 7,
      outputTokens: 4,
      cachedInputTokens: 0,
      reasoningTokens: 2,
    };
    expect(addUsageTotals(a, b)).toEqual({
      steps: 3,
      inputTokens: 107,
      outputTokens: 44,
      cachedInputTokens: 7,
      reasoningTokens: 2,
    });
  });
});
