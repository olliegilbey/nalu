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

  it("XML-escapes `&`/`<`/`>` in concept names", () => {
    // Concept names originate from LLM scoping output and may legally contain
    // reserved XML chars. `escapeXmlText` handles `&`/`<`/`>` (quotes are
    // text-content-safe and intentionally left raw — see escapeXmlText.ts).
    const out = renderConceptInjection(
      [{ name: "Supply & demand <basics>", tier: 1, lastQuality: null }],
      [],
    );
    expect(out).toContain("Supply &amp; demand &lt;basics&gt;");
    expect(out).not.toContain("Supply & demand"); // raw form must not appear
  });

  it("omits the last-quality suffix when due.lastQuality is null", () => {
    // Type permits null in the due set (never-assessed-but-somehow-due edge);
    // the renderer should drop the score clause entirely rather than emit
    // `last scored null/5`.
    const out = renderConceptInjection([], [{ name: "Markets", tier: 1, lastQuality: null }]);
    expect(out).toContain('- "Markets" (tier 1)');
    expect(out).not.toContain("last scored");
  });
});
