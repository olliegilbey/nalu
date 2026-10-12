import { describe, expect, it } from "vitest";
import { renderWaveTurnEnvelope } from "./waveTurn";

describe("renderWaveTurnEnvelope", () => {
  it("wraps learner input with stage label and <turns_remaining>", () => {
    const out = renderWaveTurnEnvelope({
      learnerInput: "<learner_reply>hello</learner_reply>",
      turnsRemaining: 5,
    });
    expect(out).toContain("<stage>teaching turn</stage>");
    expect(out).toContain("<turns_remaining>5</turns_remaining>");
    expect(out).toContain("<learner_reply>hello</learner_reply>");
  });

  it("never inlines a <response_schema> block (tool definitions carry the schema)", () => {
    const out = renderWaveTurnEnvelope({
      learnerInput: "x",
      turnsRemaining: 0,
    });
    expect(out).not.toContain("<response_schema>");
  });
});
