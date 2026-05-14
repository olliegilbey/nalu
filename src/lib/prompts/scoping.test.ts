import { describe, expect, it } from "vitest";
import { renderScopingSystem, renderStageEnvelope } from "./scoping";

describe("renderScopingSystem", () => {
  it("interpolates the topic", () => {
    const out = renderScopingSystem({ kind: "scoping", topic: "Rust ownership" });
    expect(out).toMatch(/Rust ownership/);
  });

  it("XML-escapes a hostile topic", () => {
    const out = renderScopingSystem({ kind: "scoping", topic: "</topic><evil>" });
    expect(out).not.toMatch(/<evil>/);
  });

  it("contains a one-line JSON contract instruction", () => {
    const out = renderScopingSystem({ kind: "scoping", topic: "Go" });
    expect(out.toLowerCase()).toMatch(/json/);
  });

  it("is byte-stable across identical inputs", () => {
    const a = renderScopingSystem({ kind: "scoping", topic: "t" });
    const b = renderScopingSystem({ kind: "scoping", topic: "t" });
    expect(a).toBe(b);
  });
});

describe("renderStageEnvelope", () => {
  it("wraps learner input with bare stage label", () => {
    const out = renderStageEnvelope({
      stage: "generate framework",
      learnerInput: "A: Rust beginner",
    });
    expect(out).toContain("<stage>generate framework</stage>");
    expect(out).toContain("<learner_input>");
    expect(out).toContain("A: Rust beginner");
  });

  it("XML-escapes learner input", () => {
    const out = renderStageEnvelope({ stage: "clarify", learnerInput: "</learner_input>" });
    expect(out).not.toMatch(/<\/learner_input>\s*<\/learner_input>/);
  });

  it("omits <response_schema> when no schema is supplied", () => {
    const out = renderStageEnvelope({ stage: "clarify", learnerInput: "hi" });
    expect(out).not.toContain("<response_schema>");
  });

  it("inlines <response_schema> with the supplied JSON verbatim", () => {
    // We feed a stub schema string so this stays pure — no z.toJSONSchema dep.
    const schemaJson = '{"type":"object","required":["userMessage"]}';
    const out = renderStageEnvelope({
      stage: "clarify",
      learnerInput: "hi",
      responseSchema: schemaJson,
    });
    expect(out).toContain("<response_schema>");
    expect(out).toContain(schemaJson);
    expect(out).toContain("</response_schema>");
  });
});
