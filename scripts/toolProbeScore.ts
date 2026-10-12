/**
 * Pure scoring for the `--tools` gate in `probe-model.ts`. It lives apart so
 * unit tests can import it; importing `probe-model.ts` runs the probe.
 *
 * The gate's unit is the trial, not the call. The probe's system prompt
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
