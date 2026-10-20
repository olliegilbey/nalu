import { describe, it, expect, vi } from "vitest";
import { renderScopingCloseStage } from "./scopingClose";

// File-wide: a ratio no default uses, so the pinned text below proves the
// rule reads `BASELINE.tierMasteryRatio` rather than a literal 80%.
vi.mock("@/lib/config/tuning", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/config/tuning")>();
  return { ...orig, BASELINE: { ...orig.BASELINE, tierMasteryRatio: 0.65 } };
});

describe("renderScopingCloseStage", () => {
  it("renders the stage, the escaped learner input, then the placement rule", () => {
    const out = renderScopingCloseStage({ learnerInput: '{"a":"<b>"}', scopeTiers: [1, 2, 3] });
    expect(out).toBe(
      [
        "<stage>close scoping</stage>",
        "<learner_input>",
        '{"a":"&lt;b&gt;"}',
        "</learner_input>",
        "<placement_rule>",
        "The harness places the learner from the gradings. A level is mastered when at least 65% of its baseline answers are correct (qualityScore 4-5). Each answer counts under its question's level. The learner starts at the lowest level in scope (1, 2, 3) where under 65% of answers are correct, or at the highest level if all are mastered. A level with no answers counts as under 65%. Pitch the first lesson's opening text and planned concepts at that level.",
        "</placement_rule>",
      ].join("\n"),
    );
  });

  it("states the percentage from the tuning value, never the default", () => {
    const out = renderScopingCloseStage({ learnerInput: "{}", scopeTiers: [2, 3] });
    expect(out).toContain("at least 65%");
    expect(out).not.toContain("80%");
  });

  // The envelope is persisted as a Context row; same inputs must give same bytes.
  it("is byte-stable across identical inputs, whatever the scope order", () => {
    const a = renderScopingCloseStage({ learnerInput: "{}", scopeTiers: [3, 1, 2] });
    const b = renderScopingCloseStage({ learnerInput: "{}", scopeTiers: [1, 2, 3] });
    expect(a).toBe(b);
    expect(a).toContain("(1, 2, 3)");
  });
});
