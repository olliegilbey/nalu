import { describe, expect, it } from "vitest";
import { makeWaveCloseSchema, renderWaveCloseEnvelope } from "./waveClose";

const params = {
  scopeTiers: [1, 2, 3],
  questionIds: ["q1"],
  freshConceptNames: ["A"],
  reviewDueNames: ["B"],
  existingConceptNames: ["A", "B"],
};

const validBase = {
  userMessage: "Closing up.",
  summary: "We made progress.",
  gradings: [{ kind: "mc-index" as const, questionId: "q1", rationale: "Right click. Move on." }],
  nextUnitBlueprint: {
    topic: "Next",
    outline: ["beat 1"],
    openingText: "Hi.",
    plannedConcepts: [{ name: "A", tier: 2, role: "fresh" as const }],
  },
};

describe("makeWaveCloseSchema", () => {
  it("accepts a valid close payload with empty conceptUpdates", () => {
    const schema = makeWaveCloseSchema(params);
    const r = schema.safeParse({ ...validBase, conceptUpdates: [] });
    expect(r.success).toBe(true);
  });

  it("accepts conceptUpdates referencing existing concepts", () => {
    const schema = makeWaveCloseSchema(params);
    const r = schema.safeParse({
      ...validBase,
      conceptUpdates: [{ name: "B", qualityScore: 4, reason: "Retaught via worked example." }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects conceptUpdates referencing unknown concept", () => {
    const schema = makeWaveCloseSchema(params);
    const r = schema.safeParse({
      ...validBase,
      conceptUpdates: [{ name: "Ghost", qualityScore: 3, reason: "?" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toContain("Ghost");
    }
  });

  it("rejects duplicate conceptUpdates names (double SM-2 advance guard)", () => {
    const schema = makeWaveCloseSchema(params);
    const r = schema.safeParse({
      ...validBase,
      conceptUpdates: [
        { name: "B", qualityScore: 4, reason: "Answered correctly." },
        { name: "B", qualityScore: 2, reason: "Stumbled on the follow-up." },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes("duplicate conceptUpdates"))).toBe(true);
    }
  });

  it("accepts conceptUpdates with distinct names", () => {
    const schema = makeWaveCloseSchema(params);
    const r = schema.safeParse({
      ...validBase,
      conceptUpdates: [
        { name: "A", qualityScore: 5, reason: "Explained it unprompted." },
        { name: "B", qualityScore: 3, reason: "Partial grasp." },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("renderWaveCloseEnvelope", () => {
  it("includes the close-stage label, turns_remaining=0, and concepts_for_next_wave block", () => {
    const out = renderWaveCloseEnvelope({
      learnerInput: "<learner_reply>x</learner_reply>",
      conceptsForNextWaveBlock: "<concepts_for_next_wave>...</concepts_for_next_wave>",
    });
    expect(out).toContain("close wave");
    expect(out).toContain("<turns_remaining>0</turns_remaining>");
    expect(out).toContain("<concepts_for_next_wave>");
  });

  it("inlines responseSchema without a blank line before it", () => {
    const out = renderWaveCloseEnvelope({
      learnerInput: "x",
      conceptsForNextWaveBlock: "<concepts_for_next_wave>...</concepts_for_next_wave>",
      responseSchema: '{"type":"object"}',
    });
    expect(out).toContain('<response_schema>{"type":"object"}</response_schema>');
    // Bytes matter for cache-prefix stability across turns.
    expect(out).not.toMatch(/<\/concepts_for_next_wave>\n\n<response_schema>/);
  });
});
