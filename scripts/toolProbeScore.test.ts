import { describe, it, expect } from "vitest";
import {
  restatesQuizQuestion,
  scoreQuizRequestStep,
  scoreToolProbe,
  type ProbeTrial,
} from "./toolProbeScore";

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
    expect(score.verdict).toBe("NO-GO");
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

  it("keeps transport errors out of the pass rate, but calls the run INCONCLUSIVE", () => {
    // A flaky network is not a model verdict, so it neither passes nor fails
    // a trial. A run with an unscored trial cannot reach GO or NO-GO.
    const score = scoreToolProbe([...times(19, passing()), { kind: "transport-error" }]);
    expect(score.scoredTrials).toBe(19);
    expect(score.passRate).toBe(1);
    expect(score.verdict).toBe("INCONCLUSIVE");
  });

  it("is INCONCLUSIVE, not GO, when 19 of 20 trials hit transport errors", () => {
    // One passing trial gives a 100% pass rate. Without the every-trial-scored
    // rule, that alone would pass the gate.
    const score = scoreToolProbe([passing(), ...times(19, { kind: "transport-error" })]);
    expect(score.passRate).toBe(1);
    expect(score.verdict).toBe("INCONCLUSIVE");
  });

  it("is GO at exactly 95% with median steps at the limit", () => {
    const score = scoreToolProbe([...times(19, passing(3)), noCall(3)]);
    expect(score.passRate).toBeCloseTo(0.95);
    expect(score.medianSteps).toBe(3);
    expect(score.verdict).toBe("GO");
  });

  it("is NO-GO when the median trial needs more than 3 steps", () => {
    const score = scoreToolProbe(times(20, passing(4)));
    expect(score.passRate).toBe(1);
    expect(score.medianSteps).toBe(4);
    expect(score.verdict).toBe("NO-GO");
  });

  it("is INCONCLUSIVE when no trial reached the model", () => {
    const score = scoreToolProbe(times(3, { kind: "transport-error" }));
    expect(score.scoredTrials).toBe(0);
    expect(score.passRate).toBe(0);
    expect(score.verdict).toBe("INCONCLUSIVE");
  });
});

describe("scoreQuizRequestStep", () => {
  it("reads a presentQuestionnaire call as the quiz posed", () => {
    const score = scoreQuizRequestStep({
      toolNames: ["presentQuestionnaire"],
      text: "",
    });
    expect(score).toEqual({ calledQuiz: true, jsonInText: false });
  });

  it("reads a lookup call alone as no quiz posed", () => {
    const score = scoreQuizRequestStep({ toolNames: ["getConceptHistory"], text: "" });
    expect(score.calledQuiz).toBe(false);
  });

  it("flags prose that ends in a JSON object, as issue #164 saw", () => {
    const text =
      'Here is one more idea about borrowing.\n{\n  "explanation": "A shared borrow reads over a plain mutable reference."\n}';
    expect(scoreQuizRequestStep({ toolNames: [], text })).toEqual({
      calledQuiz: false,
      jsonInText: true,
    });
  });

  it("passes prose with a fenced code block, braces and all", () => {
    const text =
      "Look at this:\n```rust\nfn main() {\n    let s = String::new();\n}\n```\nWhat do you notice?";
    expect(scoreQuizRequestStep({ toolNames: [], text }).jsonInText).toBe(false);
  });
});

describe("restatesQuizQuestion", () => {
  const prompt = "In your own words, explain why `let s2 = s1;` makes s1 unusable afterwards.";

  it("flags the prompt written out verbatim, whatever its case and markdown", () => {
    const message = `Nice work so far. **Quick check:** in your own words, explain why let s2 = s1; makes \`s1\` unusable afterwards.`;
    expect(restatesQuizQuestion(message, [prompt])).toBe(true);
  });

  it("flags a verbatim prompt that spans two sentences", () => {
    const twoSentences = "Consider a String moved into s2. What happens if you then print s1?";
    const message = `Your turn. Consider a String moved into s2. What happens if you then print s1?`;
    expect(restatesQuizQuestion(message, [twoSentences])).toBe(true);
  });

  it("flags one sentence that holds most of the prompt's words", () => {
    const message =
      "Moves are the heart of ownership. So, explain in your own words why s1 becomes unusable after let s2 = s1.";
    expect(restatesQuizQuestion(message, [prompt])).toBe(true);
  });

  it("passes a short lead-in to the quiz card", () => {
    const message = "That is the move rule in action. Try this one below.";
    expect(restatesQuizQuestion(message, [prompt])).toBe(false);
  });

  it("passes on-topic prose whose shared words spread over several sentences", () => {
    // The whole message holds most of the prompt's words, as any lesson on
    // the topic would. No single sentence does, so it is not a restatement.
    const message =
      "When you write let s2 = s1, ownership moves. Rust makes s1 unusable from then on. " +
      "Afterwards, only s2 owns the heap data. Put it in your own words in the quiz below.";
    expect(restatesQuizQuestion(message, [prompt])).toBe(false);
  });

  it("flags a message that restates any one of several questions", () => {
    const other = "Which keyword makes a binding mutable?";
    const message = "Two quick ones below. Which keyword makes a binding mutable?";
    expect(restatesQuizQuestion(message, [prompt, other])).toBe(true);
  });

  it("passes when the quiz has no questions to restate", () => {
    expect(restatesQuizQuestion("Anything at all.", [])).toBe(false);
  });
});
