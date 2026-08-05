import { describe, it, expect } from "vitest";
import { llmProviderStore, parseLlmProviderCookie, runWithLlmProvider } from "./llmProviderStore";

describe("parseLlmProviderCookie", () => {
  it("returns undefined for a missing header", () => {
    expect(parseLlmProviderCookie(null)).toBeUndefined();
  });

  it("parses a lone cookie", () => {
    expect(parseLlmProviderCookie("nalu-llm-provider=corti")).toBe("corti");
  });

  it("parses among other cookies", () => {
    expect(parseLlmProviderCookie("a=b; nalu-llm-provider=cerebras; c=d")).toBe("cerebras");
  });

  it("rejects unknown values", () => {
    expect(parseLlmProviderCookie("nalu-llm-provider=gpt5")).toBeUndefined();
  });

  it("does not match a suffix of another cookie name", () => {
    expect(parseLlmProviderCookie("x-nalu-llm-provider=corti")).toBeUndefined();
  });
});

describe("runWithLlmProvider", () => {
  it("binds the provider to ALS scope", () => {
    runWithLlmProvider("corti", () => {
      expect(llmProviderStore.getStore()).toBe("corti");
    });
  });

  it("leaves scope unbound when provider is undefined", () => {
    runWithLlmProvider(undefined, () => {
      expect(llmProviderStore.getStore()).toBeUndefined();
    });
  });
});
