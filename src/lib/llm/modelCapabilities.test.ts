import { describe, it, expect } from "vitest";
import { getModelCapabilities } from "./modelCapabilities";

describe("getModelCapabilities", () => {
  it("returns honorsStrictMode=false for llama3.1-8b", () => {
    expect(getModelCapabilities("llama3.1-8b").honorsStrictMode).toBe(false);
  });

  it("returns honorsStrictMode=true for llama-3.3-70b", () => {
    expect(getModelCapabilities("llama-3.3-70b").honorsStrictMode).toBe(true);
  });

  it("defaults to honorsStrictMode=false for unknown models", () => {
    // Safer direction: assume an unknown model ignores strict-mode unless we've
    // explicitly registered it as honouring. Strong models parse-and-ignore the
    // resulting inline `<response_schema>` block — cheap insurance against
    // silent free-form JSON from a not-yet-registered weak model.
    expect(getModelCapabilities("some-future-model-7b").honorsStrictMode).toBe(false);
  });

  it("is case-sensitive — does not normalise model names", () => {
    // "LLAMA3.1-8B" is NOT in the registry; should get the default (false), not true.
    expect(getModelCapabilities("LLAMA3.1-8B").honorsStrictMode).toBe(false);
  });
});
