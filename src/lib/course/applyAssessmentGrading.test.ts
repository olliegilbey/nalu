import { describe, expect, it, vi, beforeEach } from "vitest";

// The DB write is mocked: these tests pin the patch the grading computes,
// not the SQL underneath (the integration suite covers the write).
vi.mock("@/db/queries/assessments.grade", () => ({
  updateAssessmentGrading: vi.fn(),
}));

// Off-default MC qualities, file-wide: a hardcoded 4/1 can no longer pass
// for "reads the tunables" (issue #95).
vi.mock("@/lib/config/tuning", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/config/tuning")>();
  return {
    ...orig,
    BASELINE: { ...orig.BASELINE, mcCorrectQuality: 5, mcIncorrectQuality: 2 },
  };
});

import { updateAssessmentGrading } from "@/db/queries/assessments.grade";
import type { DbOrTx } from "@/db/client";
import { applyAssessmentGrading } from "./applyAssessmentGrading";

beforeEach(() => {
  vi.clearAllMocks();
});

/** Grade one mid-Wave MC answer and return the quality score written. */
async function writtenMcQuality(correct: boolean): Promise<unknown> {
  await applyAssessmentGrading({
    assessmentId: "a-1",
    conceptTier: 1,
    signal: { kind: "mc-index", questionId: "q1", correct },
    tx: {} as DbOrTx,
  });
  return vi.mocked(updateAssessmentGrading).mock.calls[0]![1].qualityScore;
}

describe("applyAssessmentGrading (mid-Wave MC quality)", () => {
  it("writes BASELINE.mcCorrectQuality for a correct click", async () => {
    expect(await writtenMcQuality(true)).toBe(5);
  });

  it("writes BASELINE.mcIncorrectQuality for an incorrect click", async () => {
    expect(await writtenMcQuality(false)).toBe(2);
  });
});
