import { describe, it, expect } from "vitest";
import { renderScopingCloseStage } from "./scopingClose";

describe("renderScopingCloseStage", () => {
  it("emits an XML envelope with the stage label and learner payload", () => {
    const out = renderScopingCloseStage({
      learnerInput: '{"items":[]}',
    });
    expect(out).toContain("<stage>close scoping</stage>");
    expect(out).toContain("<learner_input>");
  });
});
