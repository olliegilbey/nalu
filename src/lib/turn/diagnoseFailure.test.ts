import { describe, expect, it } from "vitest";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
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

  // Issue #129: a well-formed baseline that broke only the scope superRefine
  // was diagnosed as "answered the wrong turn". Zod runs refines only once the
  // shape parses, so an all-`custom` issue list means the body fit this turn.
  it("names the broken rule when only a refine failed on a well-formed body", () => {
    const issues = [
      {
        code: "custom",
        path: ["questions", "questions", 6, "tier"],
        message: "question b7 tier 3 is outside the requested scope [1, 2]",
      },
    ];
    const err = fail(JSON.stringify(issues, null, 2));
    const raw =
      '{"userMessage":"hi","questions":{"questions":[{"id":"b7","type":"free_text","prompt":"p","freetextRubric":"r","conceptName":"c","tier":3,"correct":"A"}]}}';
    const out = diagnoseFailure(err, raw);
    expect(out).toContain("question b7 tier 3 is outside the requested scope [1, 2]");
    expect(out).toContain("questions.questions.6.tier");
    expect(out).not.toMatch(/wrong turn/);
  });

  it("falls back to a generic message when no heuristic matches", () => {
    const err = fail("something else");
    expect(diagnoseFailure(err, '{"x":"y"}')).toMatch(/zod|gate|directive/i);
  });
});
