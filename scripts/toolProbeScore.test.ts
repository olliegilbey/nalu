import { describe, it, expect } from "vitest";
import { scoreToolProbe, type ProbeTrial } from "./toolProbeScore";

/** A finished trial that made one valid `presentQuestionnaire` call in `steps` steps. */
function passing(steps = 2): ProbeTrial {
  return {
    kind: "completed",
    steps,
    calls: [{ toolName: "presentQuestionnaire", invalid: false }],
  };
}

/** A finished trial where the model taught but called no tool. */
function noCall(steps = 1): ProbeTrial {
  return { kind: "completed", steps, calls: [] };
}

/** `n` copies of a trial. */
function times(n: number, trial: ProbeTrial): ProbeTrial[] {
  return Array.from({ length: n }, () => trial);
}

describe("scoreToolProbe", () => {
  it("counts a trial that teaches without calling as a failed trial", () => {
    // 18 of 20 trials make the required call. Counting calls instead of
    // trials would report 18/18 = 100% and pass the gate.
    const score = scoreToolProbe([...times(18, passing()), ...times(2, noCall())]);
    expect(score.scoredTrials).toBe(20);
    expect(score.passedTrials).toBe(18);
    expect(score.passRate).toBeCloseTo(0.9);
    expect(score.go).toBe(false);
  });

  it("fails a trial that calls only the other tool", () => {
    const signalsOnly: ProbeTrial = {
      kind: "completed",
      steps: 2,
      calls: [{ toolName: "recordComprehensionSignals", invalid: false }],
    };
    const score = scoreToolProbe([passing(), signalsOnly]);
    expect(score.passedTrials).toBe(1);
    expect(score.passRate).toBeCloseTo(0.5);
  });

  it("fails a trial whose only questionnaire call is invalid", () => {
    const invalidOnly: ProbeTrial = {
      kind: "completed",
      steps: 2,
      calls: [{ toolName: "presentQuestionnaire", invalid: true }],
    };
    expect(scoreToolProbe([invalidOnly]).passedTrials).toBe(0);
  });

  it("passes a trial that self-corrects an invalid call in-loop", () => {
    // The SDK feeds the tool error back; the model retries within the trial.
    // The extra step shows up in medianSteps, not the pass rate.
    const selfCorrected: ProbeTrial = {
      kind: "completed",
      steps: 3,
      calls: [
        { toolName: "presentQuestionnaire", invalid: true },
        { toolName: "presentQuestionnaire", invalid: false },
      ],
    };
    const score = scoreToolProbe([selfCorrected]);
    expect(score.passedTrials).toBe(1);
    expect(score.passRate).toBe(1);
  });

  it("counts a trial once however many valid calls it makes", () => {
    const twice: ProbeTrial = {
      kind: "completed",
      steps: 3,
      calls: [
        { toolName: "presentQuestionnaire", invalid: false },
        { toolName: "presentQuestionnaire", invalid: false },
      ],
    };
    const score = scoreToolProbe([twice, noCall()]);
    expect(score.passedTrials).toBe(1);
    expect(score.passRate).toBeCloseTo(0.5);
  });

  it("fails a trial where the SDK threw on an invalid call", () => {
    const score = scoreToolProbe([passing(), { kind: "invalid-call-thrown" }]);
    expect(score.scoredTrials).toBe(2);
    expect(score.passedTrials).toBe(1);
  });

  it("leaves transport errors out of the denominator", () => {
    // A flaky network is not a model verdict, so it must not cause NO-GO.
    const score = scoreToolProbe([...times(19, passing()), { kind: "transport-error" }]);
    expect(score.scoredTrials).toBe(19);
    expect(score.passRate).toBe(1);
    expect(score.go).toBe(true);
  });

  it("is GO at exactly 95% with median steps at the limit", () => {
    const score = scoreToolProbe([...times(19, passing(3)), noCall(3)]);
    expect(score.passRate).toBeCloseTo(0.95);
    expect(score.medianSteps).toBe(3);
    expect(score.go).toBe(true);
  });

  it("is NO-GO when the median trial needs more than 3 steps", () => {
    const score = scoreToolProbe(times(20, passing(4)));
    expect(score.passRate).toBe(1);
    expect(score.medianSteps).toBe(4);
    expect(score.go).toBe(false);
  });

  it("is NO-GO when no trial reached the model", () => {
    const score = scoreToolProbe(times(3, { kind: "transport-error" }));
    expect(score.scoredTrials).toBe(0);
    expect(score.passRate).toBe(0);
    expect(score.go).toBe(false);
  });
});
