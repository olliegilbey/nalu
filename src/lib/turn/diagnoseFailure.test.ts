import { describe, expect, it } from "vitest";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import { diagnoseFailure } from "./diagnoseFailure";

const fail = (msg: string) => new ValidationGateFailure("missing_response", msg);

// The detail executeTurn builds: Zod v4's issue list, as `ZodError.message`.
const failWith = (...issues: readonly object[]) => fail(JSON.stringify(issues, null, 2));

// Zod v4 issues, byte-shaped as `safeParse` reports them.
const missing = (key: string, expected: string) => ({
  expected,
  code: "invalid_type",
  path: [key],
  message: `Invalid input: expected ${expected}, received undefined`,
});
const emptyString = (key: string) => ({
  origin: "string",
  code: "too_small",
  minimum: 1,
  inclusive: true,
  path: [key],
  message: "Too small: expected string to have >=1 characters",
});

// Minimal right-stage bodies: each carries its stage's top-level keys.
const frameworkBody = {
  userMessage: "hi",
  tiers: [{ number: 1, name: "a", description: "d", exampleConcepts: ["x"] }],
  estimatedStartingTier: 1,
  baselineScopeTiers: [1],
};
const baselineBody = {
  userMessage: "hi",
  questions: {
    questions: [
      {
        id: "b1",
        type: "free_text",
        prompt: "p",
        freetextRubric: "r",
        conceptName: "c",
        tier: 1,
        correct: "A",
      },
    ],
  },
};
const closeBase = {
  userMessage: "hi",
  gradings: [
    {
      kind: "free-text",
      questionId: "q1",
      verdict: "correct",
      qualityScore: 5,
      conceptName: "c",
      conceptTier: 1,
      rationale: "r",
    },
  ],
  summary: "s",
  nextUnitBlueprint: {
    topic: "t",
    outline: ["o"],
    openingText: "o",
    plannedConcepts: [{ name: "c", tier: 1 }],
  },
};
const scopingCloseBody = { ...closeBase, immutableSummary: "i", startingTier: 1 };
const waveCloseBody = {
  ...closeBase,
  conceptUpdates: [{ name: "c", qualityScore: 4, reason: "r" }],
};

/** `body` as raw model text, minus the named top-level keys. */
const rawWithout = (body: Record<string, unknown>, ...dropped: readonly string[]) =>
  JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !dropped.includes(k))));

describe("diagnoseFailure (JSON contract)", () => {
  it("calls out a non-JSON response", () => {
    const err = fail("Your previous response did not parse as JSON.");
    expect(diagnoseFailure(err, "<framework>...</framework>", "framework")).toMatch(/json/i);
  });

  // Every stage requires `userMessage`. A body missing it is still this
  // turn's body, so it must not read as a wrong turn (issue #130).
  it.each([
    ["framework", frameworkBody],
    ["baseline", baselineBody],
  ] as const)("calls out a missing userMessage on a %s body", (label, body) => {
    const err = failWith(missing("userMessage", "string"));
    const out = diagnoseFailure(err, rawWithout(body, "userMessage"), label);
    expect(out).toMatch(/`userMessage`.*every turn must include/);
    expect(out).not.toMatch(/wrong turn/);
  });

  it("notes a cross-stage payload (framework keys in a baseline turn)", () => {
    const err = failWith(missing("questions", "object"));
    const out = diagnoseFailure(err, rawWithout(frameworkBody), "baseline");
    expect(out).toMatch(/framework stage .* wrong turn/);
  });

  it("notes a cross-stage payload between the two close turns", () => {
    const err = failWith(missing("conceptUpdates", "array"));
    const out = diagnoseFailure(err, rawWithout(scopingCloseBody), "wave-close");
    expect(out).toMatch(/scoping-close stage .* wrong turn/);
  });

  // Issue #130: the stage guess reads only the body's keys, so a right-stage
  // body matches its own stage. These bodies are this turn's, each with one
  // broken key: list the issues, never claim a wrong turn.
  it("lists nested shape issues on a right-stage body", () => {
    const err = failWith({
      expected: "string",
      code: "invalid_type",
      path: ["questions", "questions", 0, "prompt"],
      message: "Invalid input: expected string, received undefined",
    });
    const out = diagnoseFailure(err, rawWithout(baselineBody), "baseline");
    expect(out).toContain("questions.questions.0.prompt: Invalid input");
    expect(out).not.toMatch(/wrong turn/);
  });

  it("lists a mistyped top-level key on a right-stage framework body", () => {
    const err = failWith({
      expected: "number",
      code: "invalid_type",
      path: ["estimatedStartingTier"],
      message: "Invalid input: expected number, received string",
    });
    const raw = JSON.stringify({ ...frameworkBody, estimatedStartingTier: "1" });
    const out = diagnoseFailure(err, raw, "framework");
    expect(out).toContain("estimatedStartingTier: Invalid input: expected number");
    expect(out).not.toMatch(/wrong turn/);
  });

  it.each([
    ["scoping-close", "startingTier", "number", scopingCloseBody],
    ["wave-close", "summary", "string", waveCloseBody],
    // Ties the scoping-close signature on the shared close keys.
    ["wave-close", "conceptUpdates", "array", waveCloseBody],
  ] as const)(
    "lists a missing top-level key on a right-stage %s body (%s)",
    (label, key, type, body) => {
      const err = failWith(missing(key, type));
      const out = diagnoseFailure(err, rawWithout(body, key), label);
      expect(out).toContain(`${key}: Invalid input`);
      expect(out).not.toMatch(/wrong turn/);
    },
  );

  it.each(["summary", "userMessage"])(
    "lists a one-segment non-type issue on a right-stage body (%s)",
    (key) => {
      const err = failWith(emptyString(key));
      const raw = JSON.stringify({ ...waveCloseBody, [key]: "" });
      const out = diagnoseFailure(err, raw, "wave-close");
      expect(out).toContain(`${key}: Too small`);
      expect(out).not.toMatch(/wrong turn|every turn must include/);
    },
  );

  // A label with no stage signature cannot name the expected stage.
  it("lists the issues when the label names no known stage", () => {
    const err = failWith(missing("questions", "object"));
    const out = diagnoseFailure(err, rawWithout(frameworkBody), "scoping");
    expect(out).toContain("questions: Invalid input");
    expect(out).not.toMatch(/wrong turn/);
  });

  // Issue #129: a well-formed baseline that broke only the scope superRefine
  // was diagnosed as "answered the wrong turn". Zod runs refines only once the
  // shape parses, so an all-`custom` issue list means the body fit this turn.
  it("names the broken rule when only a refine failed on a well-formed body", () => {
    const err = failWith({
      code: "custom",
      path: ["questions", "questions", 6, "tier"],
      message: "question b7 tier 3 is outside the requested scope [1, 2]",
    });
    const out = diagnoseFailure(err, rawWithout(baselineBody), "baseline");
    expect(out).toContain(
      "questions.questions.6.tier: question b7 tier 3 is outside the requested scope [1, 2]",
    );
    expect(out).not.toMatch(/wrong turn/);
  });

  it("falls back to a generic message when the detail is no issue list", () => {
    const err = fail("something else");
    expect(diagnoseFailure(err, '{"x":"y"}', "framework")).toMatch(/gate .* tripped/);
  });
});
