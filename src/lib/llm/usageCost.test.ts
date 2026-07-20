import { describe, it, expect } from "vitest";
import { CEREBRAS_PRICING } from "@/lib/config/tuning";
import type { LlmUsage } from "@/lib/types/llm";
import { calculateUsageCostUsd, sumUsage } from "./usageCost";

/**
 * Build a full `LlmUsage` from a partial override. The AI SDK type carries
 * detail sub-objects we rarely set in a test; this keeps each case to the
 * two-or-three fields under test.
 */
function makeUsage(partial: Partial<LlmUsage> = {}): LlmUsage {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    ...partial,
  };
}

// Per-token rates derived from the tunable so the assertions track the
// constant rather than hardcoding a rate that a pricing change would break.
const inputRate = CEREBRAS_PRICING.inputUsdPerMillionTokens / 1_000_000;
const outputRate = CEREBRAS_PRICING.outputUsdPerMillionTokens / 1_000_000;

describe("calculateUsageCostUsd", () => {
  it("charges input and output tokens at their respective rates", () => {
    const cost = calculateUsageCostUsd(makeUsage({ inputTokens: 1000, outputTokens: 500 }));
    expect(cost).toBeCloseTo(1000 * inputRate + 500 * outputRate, 12);
  });

  it("pins the concrete headline rate: 1M input tokens = $0.35", () => {
    expect(calculateUsageCostUsd(makeUsage({ inputTokens: 1_000_000 }))).toBeCloseTo(0.35, 12);
  });

  it("pins the concrete headline rate: 1M output tokens = $0.75", () => {
    expect(calculateUsageCostUsd(makeUsage({ outputTokens: 1_000_000 }))).toBeCloseTo(0.75, 12);
  });

  it("treats undefined token counts as zero", () => {
    expect(calculateUsageCostUsd(makeUsage())).toBe(0);
  });

  // The load-bearing invariant: caching is NOT a discount on Cerebras.
  it("does NOT discount cached input tokens — cached bills at full input rate", () => {
    const fullyCached = makeUsage({
      inputTokens: 2000,
      outputTokens: 100,
      inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 2000, cacheWriteTokens: 0 },
      cachedInputTokens: 2000,
    });
    const uncached = makeUsage({ inputTokens: 2000, outputTokens: 100 });

    // Identical input/output counts → identical cost, regardless of cache hits.
    expect(calculateUsageCostUsd(fullyCached)).toBe(calculateUsageCostUsd(uncached));
    // And it is the FULL input charge, not a reduced one.
    expect(calculateUsageCostUsd(fullyCached)).toBeCloseTo(2000 * inputRate + 100 * outputRate, 12);
  });
});

describe("sumUsage", () => {
  it("returns an all-zero total for an empty list", () => {
    expect(sumUsage([])).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("counts calls and sums every token bucket immutably", () => {
    const a = makeUsage({
      inputTokens: 100,
      outputTokens: 40,
      inputTokenDetails: { noCacheTokens: 90, cacheReadTokens: 10, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 30, reasoningTokens: 10 },
    });
    const b = makeUsage({
      inputTokens: 200,
      outputTokens: 60,
      inputTokenDetails: { noCacheTokens: 195, cacheReadTokens: 5, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 45, reasoningTokens: 15 },
    });
    const inputs = [a, b] as const;

    expect(sumUsage(inputs)).toEqual({
      calls: 2,
      inputTokens: 300,
      outputTokens: 100,
      cachedInputTokens: 15,
      reasoningTokens: 25,
    });
    // Immutability: the source array/objects are untouched by the reduce.
    expect(inputs[0]!.inputTokens).toBe(100);
  });

  it("falls back to the deprecated cached/reasoning fields when detail objects are absent", () => {
    const legacy: LlmUsage = {
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      cachedInputTokens: 120,
      reasoningTokens: 80,
    };
    expect(sumUsage([legacy])).toEqual({
      calls: 1,
      inputTokens: 500,
      outputTokens: 200,
      cachedInputTokens: 120,
      reasoningTokens: 80,
    });
  });

  it("coerces undefined token counts to zero", () => {
    expect(sumUsage([makeUsage(), makeUsage()])).toEqual({
      calls: 2,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });
});
