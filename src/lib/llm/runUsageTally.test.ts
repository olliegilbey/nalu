import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LlmUsage } from "@/lib/types/llm";
import {
  recordUsage,
  getRunUsageTally,
  resetRunUsageTally,
  formatRunUsageTally,
} from "./runUsageTally";

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

beforeEach(() => resetRunUsageTally());
afterEach(() => resetRunUsageTally());

describe("recordUsage / getRunUsageTally", () => {
  it("starts empty", () => {
    expect(getRunUsageTally()).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("accumulates across calls", () => {
    recordUsage(
      makeUsage({
        inputTokens: 1000,
        outputTokens: 300,
        inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 250, reasoningTokens: 50 },
      }),
    );
    recordUsage(makeUsage({ inputTokens: 500, outputTokens: 100 }));

    expect(getRunUsageTally()).toEqual({
      calls: 2,
      inputTokens: 1500,
      outputTokens: 400,
      cachedInputTokens: 200,
      reasoningTokens: 50,
    });
  });

  it("does NOT write the stderr line under plain vitest (gated to prod / live smoke)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      recordUsage(makeUsage({ inputTokens: 10, outputTokens: 5 }));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // Accumulation still happened despite the silent stderr.
    expect(getRunUsageTally().calls).toBe(1);
  });
});

describe("formatRunUsageTally", () => {
  it("renders the exact acceptance line format", () => {
    recordUsage(
      makeUsage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        inputTokenDetails: {
          noCacheTokens: 900_000,
          cacheReadTokens: 100_000,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: 800_000, reasoningTokens: 200_000 },
      }),
    );
    // 1M in @ $0.35 + 1M out @ $0.75 = $1.10; cached shown but NOT discounted.
    expect(formatRunUsageTally(getRunUsageTally())).toBe(
      "run total: 1 calls, 1000000 in / 1000000 out (100000 cached, 200000 reasoning), ≈ $1.1000",
    );
  });
});
