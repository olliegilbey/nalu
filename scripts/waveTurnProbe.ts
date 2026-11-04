/**
 * Teaching-prompt probes for `probe-model.ts`: one fixed Wave Context per
 * defect, sent 20 times, scored by `toolProbeScore.ts`. Copies the #192
 * A/B method: the real system prompt, tools and provider options, and no
 * `toolChoice`, as in production.
 *
 * - `--final-quiz` (issue #164): Turn 9 at `<turns_remaining>1</turns_remaining>`,
 *   the learner asks for a short-answer quiz. One Step per trial: does it
 *   call presentQuestionnaire, and does its text hold JSON?
 * - `--quiz-lead-in` (issue #215): Turn 1, the learner asks for a
 *   short-answer quiz. The message follows the quiz call, so each trial runs
 *   the tool loop to its end. Does the message restate the quiz question?
 *
 * Model text prints to the terminal so a run can be read by hand. Never
 * paste it into a commit, PR or issue: those carry counts only.
 */

/* eslint-disable no-console -- CLI script: console is the output channel. */

import { generateText, stepCountIs, type ToolSet } from "ai";
import { buildWaveMidTurnAgent } from "@/lib/agents/waveMidTurnAgent";
import { getLlmModel, llmProviderOptions } from "@/lib/llm/provider";
import { cerebrasToolLoopPrepareStep } from "@/lib/llm/cerebrasToolLoopPrepareStep";
import { recordStepFinished } from "@/lib/llm/recordStepFinished";
import { sumUsage } from "@/lib/llm/usageCost";
import { formatUsageTotals } from "@/lib/llm/runUsageTally";
import { assembleLlmMessages } from "@/lib/turn/contextAssembly";
import { LLM } from "@/lib/config/tuning";
import type { LlmUsage } from "@/lib/types/llm";
import {
  FINAL_MID_TURN_QUIZ_REQUEST,
  PROBE_WAVE_SEED,
  TURN_1_QUIZ_REQUEST,
  probeWaveRows,
} from "./waveTurnProbe.fixtures";
import { restatesQuizQuestion, scoreQuizRequestStep } from "./toolProbeScore";

/** Trials per probe run: the #192 A/B's 20 per arm. */
const WAVE_PROBE_TRIALS = 20;

/** The Wave's final mid-turn: `<turns_remaining>1</turns_remaining>`. */
const FINAL_MID_TURN = 9;

/** Never sent to a database: the lookup tool's execute is stubbed (below). */
const PROBE_COURSE_ID = "00000000-0000-4000-8000-00000000c0de";

/** Indent model text under its trial line. */
const indent = (text: string): string => text.replace(/^/gm, "    | ");

/**
 * The mid-turn agent's instructions and tools, built by the agent's own
 * builder so the probe cannot drift from production. The lookup tool's
 * execute is stubbed to its miss answer: the probe course has no rows, and
 * the real execute would query the env's database.
 */
function buildProbeAgentParts() {
  const instance = buildWaveMidTurnAgent({
    seed: PROBE_WAVE_SEED,
    courseId: PROBE_COURSE_ID,
    waveId: PROBE_COURSE_ID,
    answeredQuestionIds: [],
  });
  const { getDueConcepts, getConceptHistory, ...emissionTools } = instance.agent.tools;
  // "hint" mode would add a second DB-backed lookup. The probe mirrors the
  // shipped "full" mode only, so it refuses to run rather than query.
  if (getDueConcepts !== undefined) throw new Error("waveTurnProbe: hint mode is not supported");
  const tools = {
    ...emissionTools,
    getConceptHistory: {
      ...getConceptHistory,
      execute: async ({ conceptName }: { conceptName: string }) => ({
        conceptName,
        attempts: [],
        notFound: true,
      }),
    },
  } satisfies ToolSet;
  return { instructions: instance.instructions, tools, collector: instance.collector };
}

/** One trial: the probe Wave at `turn`, run for at most `maxSteps` Steps with the agent's settings. */
async function runProbeTrial(params: {
  readonly turn: number;
  readonly learnerText: string;
  readonly maxSteps: number;
  readonly promptCacheKey: string;
  readonly usages: LlmUsage[];
}) {
  const parts = buildProbeAgentParts();
  // The same assembly `executeToolTurnStream` runs; it drops the leading
  // system message because the agent sends identical `instructions`.
  const [, ...messages] = assembleLlmMessages(
    PROBE_WAVE_SEED,
    [],
    probeWaveRows(params.turn, params.learnerText),
  );
  const result = await generateText({
    model: getLlmModel(),
    system: parts.instructions,
    messages,
    tools: parts.tools,
    maxOutputTokens: LLM.maxToolStepOutputTokens,
    stopWhen: stepCountIs(params.maxSteps),
    temperature: LLM.defaultTemperature,
    maxRetries: LLM.maxRetries,
    providerOptions: llmProviderOptions(params.promptCacheKey),
    prepareStep: cerebrasToolLoopPrepareStep,
    onStepFinish: (step) => {
      recordStepFinished(step.response.headers, step.usage);
      params.usages.push(step.usage);
    },
  });
  return { result, collector: parts.collector };
}

/** Probe (a), issue #164: does the final mid-turn answer a quiz request with the quiz tool? */
export async function probeFinalMidTurnQuiz(): Promise<void> {
  const promptCacheKey = `probe-${crypto.randomUUID()}`;
  const usages: LlmUsage[] = [];
  const tally = { trials: 0, calledQuiz: 0, jsonInText: 0, lookupOnly: 0, transportErrors: 0 };

  for (let trial = 0; trial < WAVE_PROBE_TRIALS; trial++) {
    try {
      const { result } = await runProbeTrial({
        turn: FINAL_MID_TURN,
        learnerText: FINAL_MID_TURN_QUIZ_REQUEST,
        maxSteps: 1,
        promptCacheKey,
        usages,
      });
      const toolNames = result.toolCalls.map((c) => c.toolName);
      const score = scoreQuizRequestStep({ toolNames, text: result.text });
      tally.trials++;
      if (score.calledQuiz) tally.calledQuiz++;
      if (score.jsonInText) tally.jsonInText++;
      if (!score.calledQuiz && toolNames.length > 0) tally.lookupOnly++;
      console.log(
        `trial ${trial}: tools=[${toolNames.join(",")}] quiz=${score.calledQuiz} json=${score.jsonInText} finish=${result.finishReason}`,
      );
      if (result.text.length > 0) console.log(indent(result.text));
    } catch (err) {
      tally.transportErrors++;
      console.log(`trial ${trial}: TRANSPORT ERROR: ${String(err)}`);
    }
  }

  console.log("\n=== final mid-turn quiz probe (#164) ===");
  console.log(
    `scored trials:          ${tally.trials} (${tally.transportErrors} transport errors)`,
  );
  console.log(`called the quiz tool:   ${tally.calledQuiz}/${tally.trials}`);
  console.log(`no quiz, other tool:    ${tally.lookupOnly}/${tally.trials}`);
  console.log(`JSON in the text:       ${tally.jsonInText}/${tally.trials}`);
  console.log(`usage: ${formatUsageTotals(sumUsage(usages))}`);
}

/** Probe (b), issue #215: does the message restate the quiz the card below it shows? */
export async function probeQuizLeadIn(): Promise<void> {
  const promptCacheKey = `probe-${crypto.randomUUID()}`;
  const usages: LlmUsage[] = [];
  const tally = { trials: 0, posedQuiz: 0, restated: 0, jsonInText: 0, transportErrors: 0 };

  for (let trial = 0; trial < WAVE_PROBE_TRIALS; trial++) {
    try {
      const { result, collector } = await runProbeTrial({
        turn: 1,
        learnerText: TURN_1_QUIZ_REQUEST,
        maxSteps: LLM.maxToolSteps,
        promptCacheKey,
        usages,
      });
      // The learner sees every Step's text, as in `streamWaveTurn`.
      const message = result.steps.map((s) => s.text).join("");
      const prompts = collector.questionnaire?.questions.map((q) => q.prompt) ?? [];
      const restated = restatesQuizQuestion(message, prompts);
      const json = scoreQuizRequestStep({ toolNames: [], text: message }).jsonInText;
      tally.trials++;
      if (prompts.length > 0) tally.posedQuiz++;
      if (restated) tally.restated++;
      if (json) tally.jsonInText++;
      const tools = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
      console.log(
        `trial ${trial}: steps=${result.steps.length} tools=[${tools.join(",")}] quiz=${prompts.length} restated=${restated} json=${json}`,
      );
      for (const prompt of prompts) console.log(`    Q: ${prompt}`);
      console.log(indent(message));
    } catch (err) {
      tally.transportErrors++;
      console.log(`trial ${trial}: TRANSPORT ERROR: ${String(err)}`);
    }
  }

  console.log("\n=== quiz lead-in probe (#215) ===");
  console.log(
    `scored trials:          ${tally.trials} (${tally.transportErrors} transport errors)`,
  );
  console.log(`posed a quiz:           ${tally.posedQuiz}/${tally.trials}`);
  console.log(`restated its question:  ${tally.restated}/${tally.posedQuiz}`);
  console.log(`JSON in the message:    ${tally.jsonInText}/${tally.trials}`);
  console.log(`usage: ${formatUsageTotals(sumUsage(usages))}`);
}
