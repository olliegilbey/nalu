import { describe, expect, it } from "vitest";
import { renderConceptInjection } from "./scheduler";

describe("renderConceptInjection", () => {
  it("renders both blocks with entries", () => {
    const out = renderConceptInjection(
      [{ name: "Demand curve", tier: 2, lastQuality: null }],
      [{ name: "Markets", tier: 1, lastQuality: 3 }],
    );
    expect(out).toContain("<concepts_for_next_wave>");
    expect(out).toContain("<fresh_at_current_tier>");
    expect(out).toContain('"Demand curve"');
    expect(out).toContain("<review_due>");
    expect(out).toContain("Markets");
    expect(out).toContain("</concepts_for_next_wave>");
  });

  it("uses (none) placeholders for empty subblocks", () => {
    const out = renderConceptInjection([], []);
    expect(out).toContain("<fresh_at_current_tier>\n(none)\n</fresh_at_current_tier>");
    expect(out).toContain("<review_due>\n(none)\n</review_due>");
  });
});
