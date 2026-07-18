import { describe, it, expect, afterEach } from "vitest";
import { llmTelemetry } from "./telemetry";

const ORIGINAL = process.env.LLM_TELEMETRY;

afterEach(() => {
  // Restore whatever the suite started with so no cross-test leakage.
  if (ORIGINAL === undefined) delete process.env.LLM_TELEMETRY;
  else process.env.LLM_TELEMETRY = ORIGINAL;
});

describe("llmTelemetry", () => {
  it("is disabled by default (flag unset)", () => {
    delete process.env.LLM_TELEMETRY;
    expect(llmTelemetry("wave-mid").isEnabled).toBe(false);
  });

  it("enables only on the exact string 'true'", () => {
    process.env.LLM_TELEMETRY = "true";
    expect(llmTelemetry("wave-mid").isEnabled).toBe(true);
    process.env.LLM_TELEMETRY = "1";
    expect(llmTelemetry("wave-mid").isEnabled).toBe(false);
  });

  it("never records inputs/outputs and carries the stage functionId", () => {
    process.env.LLM_TELEMETRY = "true";
    const t = llmTelemetry("clarify");
    // Learner content must stay out of traces — this is the invariant this
    // helper exists to centralise. Do not weaken.
    expect(t.recordInputs).toBe(false);
    expect(t.recordOutputs).toBe(false);
    expect(t.functionId).toBe("clarify");
  });
});
