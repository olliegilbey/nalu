import { describe, it, expect } from "vitest";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { parseClarifyResponse, parseFrameworkResponse, parseBaselineResponse } from "./parsers";

describe("parseClarifyResponse", () => {
  it("returns questions when <questions> contains a valid JSON array", () => {
    const raw = `<response>asking some questions</response><questions>["Beginner?","Goal?"]</questions>`;
    const r = parseClarifyResponse(raw);
    expect(r.questions).toEqual(["Beginner?", "Goal?"]);
    expect(r.raw).toBe(raw);
  });

  it("throws when <questions> tag is missing", () => {
    const raw = `<response>oops</response>`;
    expect(() => parseClarifyResponse(raw)).toThrow(ValidationGateFailure);
    try {
      parseClarifyResponse(raw);
    } catch (e) {
      const err = e as ValidationGateFailure;
      expect(err.message).toMatch(/<questions>/);
      expect(err.message).toMatch(/required/i);
    }
  });

  it("throws when <questions> JSON is malformed", () => {
    const raw = `<response>x</response><questions>[not json}</questions>`;
    expect(() => parseClarifyResponse(raw)).toThrow(ValidationGateFailure);
  });

  it("throws when <questions> array is empty", () => {
    const raw = `<response>x</response><questions>[]</questions>`;
    expect(() => parseClarifyResponse(raw)).toThrow(ValidationGateFailure);
  });

  it("throws when <questions> contains a non-string entry", () => {
    const raw = `<response>x</response><questions>["a",42]</questions>`;
    expect(() => parseClarifyResponse(raw)).toThrow(ValidationGateFailure);
  });
});

describe("parseFrameworkResponse", () => {
  const valid = {
    // userMessage required by Task 7 frameworkSchema update.
    userMessage: "Here's the ladder I drafted from your answers.",
    tiers: [
      { number: 1, name: "Basics", description: "d", exampleConcepts: ["e1", "e2", "e3", "e4"] },
      { number: 2, name: "Inter", description: "d", exampleConcepts: ["e1", "e2", "e3", "e4"] },
      { number: 3, name: "Adv", description: "d", exampleConcepts: ["e1", "e2", "e3", "e4"] },
    ],
    estimatedStartingTier: 2,
    baselineScopeTiers: [1, 2, 3],
  };

  it("returns framework on valid payload", () => {
    const raw = `<response>here</response><framework>${JSON.stringify(valid)}</framework>`;
    const r = parseFrameworkResponse(raw);
    expect(r.framework.tiers).toHaveLength(3);
  });

  it("throws when <framework> tag missing", () => {
    expect(() => parseFrameworkResponse(`<response>x</response>`)).toThrow(ValidationGateFailure);
  });

  it("throws with a directive that names the broken constraint", () => {
    const broken = { ...valid, tiers: valid.tiers.slice(0, 2) };
    const raw = `<response>x</response><framework>${JSON.stringify(broken)}</framework>`;
    try {
      parseFrameworkResponse(raw);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ValidationGateFailure;
      expect(err).toBeInstanceOf(ValidationGateFailure);
      expect(err.message.toLowerCase()).toMatch(/tier/);
    }
  });
});

describe("parseBaselineResponse", () => {
  it("throws when <baseline> tag missing", () => {
    expect(() => parseBaselineResponse(`<response>x</response>`, { scopeTiers: [1, 2] })).toThrow(
      ValidationGateFailure,
    );
  });

  it("throws when a question's tier is outside scope", () => {
    const payload = {
      questions: [
        {
          id: "b1",
          tier: 9,
          conceptName: "x",
          type: "free_text",
          question: "?",
          freetextRubric: "r",
        },
      ],
    };
    const raw = `<response>x</response><baseline>${JSON.stringify(payload)}</baseline>`;
    expect(() => parseBaselineResponse(raw, { scopeTiers: [1, 2] })).toThrow(ValidationGateFailure);
  });
});
