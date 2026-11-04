import { findJsonProseLeakIndex } from "@/lib/turn/findJsonProseLeakIndex";

/**
 * Pure scoring for the probes in `probe-model.ts`. It lives apart so unit
 * tests can import it; importing `probe-model.ts` runs the probe.
 *
 * The `--tools` gate's unit is the trial, not the call. The probe's system prompt
 * requires one `presentQuestionnaire` call per trial. A trial passes when it
 * makes that call with a valid name and input. A trial that teaches without
 * calling, or calls only the other tool, fails. Transport errors are not a
 * model verdict, so they leave the denominator. But a run with any unscored
 * trial is INCONCLUSIVE: one passing trial among 19 transport errors must not
 * read as GO.
 */

/** The call every trial must make; the probe's system prompt requires it. */
const REQUIRED_PROBE_TOOL = "presentQuestionnaire";

/** GO needs at least this share of trials to pass (2026-06-10 tool-calling plan). */
const GO_MIN_PASS_RATE = 0.95;

/** GO needs the median completed trial to finish within this many loop steps. */
const GO_MAX_MEDIAN_STEPS = 3;

/** One tool call from a finished trial. `invalid` is the SDK's flag for a bad name or bad input. */
export interface ProbeToolCall {
  readonly toolName: string;
  readonly invalid: boolean;
}

/** How one probe trial ended. */
export type ProbeTrial =
  | {
      readonly kind: "completed";
      readonly steps: number;
      readonly calls: readonly ProbeToolCall[];
    }
  | { readonly kind: "invalid-call-thrown" }
  | { readonly kind: "transport-error" };

/** The gate's outcome. INCONCLUSIVE: a transport error left a trial unscored, so rerun. */
export type ToolProbeVerdict = "GO" | "NO-GO" | "INCONCLUSIVE";

/** The gate's numbers for one probe run. */
export interface ToolProbeScore {
  /** Trials with a model verdict: every trial except transport errors. */
  readonly scoredTrials: number;
  readonly passedTrials: number;
  /** passedTrials / scoredTrials; 0 when no trial was scored. */
  readonly passRate: number;
  readonly medianSteps: number;
  readonly verdict: ToolProbeVerdict;
}

/**
 * True when the trial made the required call with a valid name and input.
 * An invalid call the model corrects in-loop still passes; its extra step
 * shows up in the median step count instead.
 */
function trialPassed(trial: ProbeTrial): boolean {
  return (
    trial.kind === "completed" &&
    trial.calls.some((c) => c.toolName === REQUIRED_PROBE_TOOL && !c.invalid)
  );
}

/** Scores one probe run against the GO gate: every trial scored, pass rate per trial, median loop depth. */
export function scoreToolProbe(trials: readonly ProbeTrial[]): ToolProbeScore {
  const scored = trials.filter((t) => t.kind !== "transport-error");
  const passedTrials = scored.filter(trialPassed).length;
  const passRate = scored.length === 0 ? 0 : passedTrials / scored.length;

  // Upper median over completed trials; a thrown trial has no step count.
  const steps = scored
    .flatMap((t) => (t.kind === "completed" ? [t.steps] : []))
    .sort((a, b) => a - b);
  const medianSteps = steps[Math.floor(steps.length / 2)] ?? 0;

  // Missing trials could swing either way, so neither GO nor NO-GO holds.
  const verdict: ToolProbeVerdict =
    scored.length < trials.length
      ? "INCONCLUSIVE"
      : passRate >= GO_MIN_PASS_RATE && medianSteps <= GO_MAX_MEDIAN_STEPS
        ? "GO"
        : "NO-GO";

  return { scoredTrials: scored.length, passedTrials, passRate, medianSteps, verdict };
}

/** One single-Step reply to a learner's quiz request, scored for issue #164. */
export interface QuizRequestStepScore {
  /** The Step called presentQuestionnaire, valid or not. */
  readonly calledQuiz: boolean;
  /** The Step's text holds JSON the Harness's leak guard would cut. */
  readonly jsonInText: boolean;
}

/**
 * Scores the `--final-quiz` probe's single Step. The #164 failure called no
 * quiz tool and ended its prose in a JSON object. The JSON check is the
 * stream's own leak guard, so it flags what a learner would see cut.
 */
export function scoreQuizRequestStep(step: {
  readonly toolNames: readonly string[];
  readonly text: string;
}): QuizRequestStepScore {
  return {
    calledQuiz: step.toolNames.includes(REQUIRED_PROBE_TOOL),
    jsonInText: findJsonProseLeakIndex(step.text) !== null,
  };
}

/** One sentence restates a question when it holds at least this share of the question's content words. */
const RESTATED_WORD_SHARE = 0.6;

/** Words that carry no content, so a shared one says nothing about a restatement. */
const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but of to in on at by for with from as is are was were be been it its " +
    "this that these those you your i we what why how which who when where do does did " +
    "can could would should will if then so not no"
  ).split(" "),
);

/** Sentence ends: `.`, `?` or `!` before whitespace, or a line break. */
const SENTENCE_BREAK = /(?<=[.?!])\s+|\n+/;

/** Lowercase words with markdown and punctuation dropped: "`let s2 = s1;`" → let, s2, s1. */
const wordsOf = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);

const contentWordsOf = (text: string): ReadonlySet<string> =>
  new Set(wordsOf(text).filter((w) => !FUNCTION_WORDS.has(w)));

/** True when the message holds the prompt verbatim, or one sentence holds most of its content words. */
function restatesPrompt(message: string, prompt: string): boolean {
  // Padded with spaces so a match starts and ends on whole words.
  if (` ${wordsOf(message).join(" ")} `.includes(` ${wordsOf(prompt).join(" ")} `)) return true;
  const target = contentWordsOf(prompt);
  if (target.size === 0) return false;
  // Per sentence, not per message: a lesson on the topic shares most of a
  // question's words across its sentences without restating it.
  return message.split(SENTENCE_BREAK).some((sentence) => {
    const held = contentWordsOf(sentence);
    const shared = [...target].filter((w) => held.has(w)).length;
    return shared / target.size >= RESTATED_WORD_SHARE;
  });
}

/**
 * Scores the `--quiz-lead-in` probe for issue #215: true when the message
 * restates any quiz question the card below it already shows. A paraphrase
 * in other words slips past; the probe counts text restatements only.
 */
export function restatesQuizQuestion(message: string, questionPrompts: readonly string[]): boolean {
  return questionPrompts.some((prompt) => restatesPrompt(message, prompt));
}
