import { describe, expect, test } from "vitest";
import { diagnoseFailure } from "./diagnoseFailure";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";

/**
 * The heuristic is intentionally simple — these tests assert the
 * *intent* of each branch fires on representative inputs. We don't try
 * to cover every phrasing of every diagnosis; we just want signal not
 * silence.
 */

describe("diagnoseFailure — tag-name mismatch (wrong stage)", () => {
  test("parser wants <baseline> but response has <framework>", () => {
    const err = new ValidationGateFailure(
      "missing_response",
      "Your response was missing the required <baseline>{...}</baseline> tag.",
    );
    const raw = `<response>blah</response><framework>{"tiers":[]}</framework>`;
    const out = diagnoseFailure(err, raw);
    expect(out).toContain("<baseline>");
    expect(out).toContain("<framework>");
    expect(out).toContain("wrong stage");
  });

  test("parser wants <framework> but no tag present at all", () => {
    const err = new ValidationGateFailure(
      "missing_response",
      "Your response was missing the required <framework>{...}</framework> tag.",
    );
    const raw = `<response>Just prose, no payload.</response>`;
    const out = diagnoseFailure(err, raw);
    expect(out).toContain("<framework>");
    expect(out).toContain("no such tag");
  });
});

describe("diagnoseFailure — shape mismatch (right wrapper, wrong payload)", () => {
  test("baseline tag present but body looks like a framework", () => {
    const err = new ValidationGateFailure(
      "missing_response",
      "Your <baseline> payload failed schema validation: foo.",
    );
    // Body has framework signatures but no baseline signatures.
    const raw = `<baseline>{"tiers":[{"n":1}],"estimatedStartingTier":2,"baselineScopeTiers":[1,2]}</baseline>`;
    const out = diagnoseFailure(err, raw);
    expect(out).toContain("<baseline>");
    expect(out).toContain("<framework>");
    expect(out).toMatch(/payload is from a different stage|matches the <framework>/);
  });
});

describe("diagnoseFailure — fallback", () => {
  test("no tag hint and no zod issue array → reason gloss", () => {
    const err = new ValidationGateFailure("missing_response", "Something generic went wrong.");
    const out = diagnoseFailure(err, "completely empty raw");
    expect(out).toContain("missing_response");
  });
});
