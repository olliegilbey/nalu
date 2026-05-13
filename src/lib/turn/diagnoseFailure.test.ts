import { describe, expect, it } from "vitest";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { diagnoseFailure } from "./diagnoseFailure";

const fail = (msg: string) => new ValidationGateFailure("missing_response", msg);

describe("diagnoseFailure (JSON contract)", () => {
  it("calls out a non-JSON response", () => {
    const err = fail("Your previous response did not parse as JSON.");
    expect(diagnoseFailure(err, "<framework>...</framework>")).toMatch(/json/i);
  });

  it("calls out a missing userMessage", () => {
    const err = fail('"userMessage": Required');
    expect(diagnoseFailure(err, '{"tiers":[]}')).toMatch(/userMessage/);
  });

  it("notes a plausible cross-stage payload (framework keys in a baseline turn)", () => {
    const err = fail("baselineScopeTiers");
    const raw =
      '{"tiers":[{"number":1,"name":"a","description":"d","exampleConcepts":["x"]}],"estimatedStartingTier":1,"baselineScopeTiers":[1]}';
    expect(diagnoseFailure(err, raw)).toMatch(/framework|stage/i);
  });

  it("falls back to a generic message when no heuristic matches", () => {
    const err = fail("something else");
    expect(diagnoseFailure(err, '{"x":"y"}')).toMatch(/zod|gate|directive/i);
  });
});
