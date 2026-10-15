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
import type { QualityScore } from "@/lib/types/spaced-repetition";
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

/** Grade one free-text answer and return the `isCorrect` written. */
async function writtenFreeTextIsCorrect(
  verdict: "correct" | "partial" | "incorrect",
  qualityScore: QualityScore,
): Promise<unknown> {
  await applyAssessmentGrading({
    assessmentId: "a-1",
    conceptTier: 1,
    signal: { kind: "free-text", questionId: "q1", verdict, qualityScore },
    tx: {} as DbOrTx,
  });
  return vi.mocked(updateAssessmentGrading).mock.calls[0]![1].isCorrect;
}

// Issue #198: the score sets XP, so the score also sets correctness. Each
// case gives a verdict that disagrees with its score; the score must win.
describe("applyAssessmentGrading (free-text correctness from qualityScore)", () => {
  it("stores isCorrect false for verdict 'correct' with qualityScore 0", async () => {
    expect(await writtenFreeTextIsCorrect("correct", 0)).toBe(false);
  });

  it("stores isCorrect true for verdict 'incorrect' with qualityScore 5", async () => {
    expect(await writtenFreeTextIsCorrect("incorrect", 5)).toBe(true);
  });

  it("stores isCorrect false for a partial-band score, whatever the verdict", async () => {
    expect(await writtenFreeTextIsCorrect("correct", 3)).toBe(false);
  });
});
