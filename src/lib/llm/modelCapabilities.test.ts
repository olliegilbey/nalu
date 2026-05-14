import { describe, it, expect } from "vitest";
import { getModelCapabilities } from "./modelCapabilities";

describe("getModelCapabilities", () => {
  it("returns honorsStrictMode=false for llama3.1-8b", () => {
    expect(getModelCapabilities("llama3.1-8b").honorsStrictMode).toBe(false);
  });

  it("returns honorsStrictMode=true for llama-3.3-70b", () => {
    expect(getModelCapabilities("llama-3.3-70b").honorsStrictMode).toBe(true);
  });

  it("defaults to honorsStrictMode=true for unknown models", () => {
    expect(getModelCapabilities("some-future-model-7b").honorsStrictMode).toBe(true);
  });

  it("is case-sensitive — does not normalise model names", () => {
    // "LLAMA3.1-8B" is NOT in the registry; should get the default (true), not false.
    expect(getModelCapabilities("LLAMA3.1-8B").honorsStrictMode).toBe(true);
  });
});
