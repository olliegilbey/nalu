import { describe, expect, test } from "vitest";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { buildRetryDirective } from "./retryDirective";

/**
 * `buildRetryDirective` is a pure string builder; tests assert on
 * substrings rather than full equality so wording can drift without
 * mass churn.
 */

const TINY_SCHEMA = '{"type":"object","required":["x"]}';

describe("buildRetryDirective — JSON-parse failure branch", () => {
  test("emits imperative prose + schema when detail flags non-JSON output", () => {
    const err = new ValidationGateFailure(
      "missing_response",
      "Your previous response did not parse as JSON. Reply with a single JSON object matching the schema attached to this turn.",
    );
    const out = buildRetryDirective(err, TINY_SCHEMA);
    expect(out).toContain("did not parse as JSON");
    // Schema is re-attached so the model has it in its retry context.
    expect(out).toContain("<response_schema>");
    expect(out).toContain(TINY_SCHEMA);
    expect(out).toContain("</response_schema>");
  });
});

describe("buildRetryDirective — Zod-validation failure branch", () => {
  test("flattens Zod issues into a bullet list with field paths", () => {
    const issues = [
      {
        expected: "string",
        code: "invalid_type",
        path: ["userMessage"],
        message: "Invalid input: expected string, received undefined",
      },
      {
        expected: "object",
        code: "invalid_type",
        path: ["questions"],
        message: "Invalid input: expected object, received undefined",
      },
    ];
    const err = new ValidationGateFailure("missing_response", JSON.stringify(issues));
    const out = buildRetryDirective(err, TINY_SCHEMA);
    // Imperative framing — not raw JSON.
    expect(out).toContain("did not match the required JSON schema");
    // Each path becomes a bullet.
    expect(out).toMatch(/- field userMessage:/);
    expect(out).toMatch(/- field questions:/);
    // Verbatim Zod messages preserved so the model sees the specific gripes.
    expect(out).toContain("expected string, received undefined");
    expect(out).toContain("expected object, received undefined");
    // Schema re-attached.
    expect(out).toContain("<response_schema>");
    expect(out).toContain(TINY_SCHEMA);
  });

  test("renders nested paths as dotted strings", () => {
    const issues = [{ path: ["questions", 0, "id"], message: "missing id" }];
    const err = new ValidationGateFailure("missing_response", JSON.stringify(issues));
    const out = buildRetryDirective(err, TINY_SCHEMA);
    expect(out).toContain("- field questions.0.id: missing id");
  });

  test("uses `<root>` when issue path is empty (top-level shape mismatch)", () => {
    const issues = [{ path: [], message: "expected object" }];
    const err = new ValidationGateFailure("missing_response", JSON.stringify(issues));
    const out = buildRetryDirective(err, TINY_SCHEMA);
    expect(out).toContain("- field <root>: expected object");
  });

  test("falls back to raw detail when detail is not a Zod issue array", () => {
    const err = new ValidationGateFailure("missing_response", "not-json-at-all");
    const out = buildRetryDirective(err, TINY_SCHEMA);
    // Imperative framing still applied.
    expect(out).toContain("did not match the required JSON schema");
    // Raw detail surfaces in the fallback line.
    expect(out).toContain("not-json-at-all");
    // Schema still re-attached.
    expect(out).toContain(TINY_SCHEMA);
  });
});
