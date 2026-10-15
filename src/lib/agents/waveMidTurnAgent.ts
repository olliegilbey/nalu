import { ToolLoopAgent, stepCountIs, type StopCondition } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { getLlmModel, llmProviderOptions } from "@/lib/llm/provider";
import { cerebrasToolLoopPrepareStep } from "@/lib/llm/cerebrasToolLoopPrepareStep";
import { recordStepFinished } from "@/lib/llm/recordStepFinished";
import { llmTelemetry } from "@/lib/llm/telemetry";
import { LLM, WAVE } from "@/lib/config/tuning";
import { renderTeachingSystem } from "@/lib/prompts/teaching";
import {
  buildWaveMidTurnTools,
  type WaveMidTurnToolkit,
  type WaveTurnCollector,
} from "@/lib/course/waveTurnTools";
import type { WaveSeedInputs } from "@/lib/types/context";
import { buildWaveLookupTools } from "./waveLookupTools";

/** Both read-only lookups, as `buildWaveLookupTools` builds them. */
type WaveLookupTools = ReturnType<typeof buildWaveLookupTools>;

/**
 * Stop condition: the last Step was cut off at the output cap (#187).
 * Without it the loop goes on after a cut-off call. That call is usually
 * invalid, and the SDK's in-loop error, which quotes the whole raw input,
 * counts as its answer. `executeToolTurnStream` fails the attempt anyway
 * (#181), so the next Step would be waste.
 */
const lastStepHitOutputCap: StopCondition<WaveMidTurnAgentTools> = ({ steps }) =>
  steps.at(-1)?.finishReason === "length";

/**
 * The mid-turn agent's full tool map: emission staging + read-only lookups.
 * `getDueConcepts` is optional: only `"hint"` mode offers it (audit F4).
 * `src/lib/types/waveStream.ts` derives the client's typed UI tool parts from
 * this, so the wire and the client can never drift on the tool surface.
 */
export type WaveMidTurnAgentTools = WaveMidTurnToolkit["tools"] &
  Pick<WaveLookupTools, "getConceptHistory"> &
  Partial<Pick<WaveLookupTools, "getDueConcepts">>;

/** Inputs that scope one agent instance to one wave turn. */
export interface WaveMidTurnAgentParams {
  /** Wave seed — renders the agent's instructions (system prompt). */
  readonly seed: WaveSeedInputs;
  /** Server-resolved course id; scopes the read-only lookup tools. */
  readonly courseId: string;
  /** The Wave's id: its Context's `prompt_cache_key` (issue #146). */
  readonly waveId: string;
  /** Question ids the learner answered this turn; the grading tool checks coverage against them. */
  readonly answeredQuestionIds: readonly string[];
  /** Model override (tests); default: the provider singleton. */
  readonly model?: LanguageModelV3;
}

/** One built agent instance: agent + its turn-scoped collector + instructions. */
export interface WaveMidTurnAgentInstance {
  readonly agent: ToolLoopAgent<never, WaveMidTurnAgentTools>;
  /** Staging collector drained by persistWaveMidTurn after the loop. */
  readonly collector: WaveTurnCollector;
  /**
   * The rendered system prompt the agent was built with — byte-identical to
   * `renderContext(seed,…).system` so the message-assembly path can drop its
   * own system message without wire drift (asserted in tests).
   */
  readonly instructions: string;
}

/**
 * The mid-Wave teaching agent (agent-loop plan Task 2): one typed unit
 * holding model, instructions, tools (emission staging + read-only lookups),
 * loop bound, and the mandatory Cerebras per-step prepareStep (pacing +
 * reasoning strip). Built FRESH per attempt — collector, answered ids and
 * lookup scope are closures over this turn; a retry must not inherit staged
 * state.
 *
 * The agent NEVER sees XP and owns no stage transitions: it can look up
 * learner state and stage emissions; deterministic code does the rest
 * (Core Design Principle, AGENTS.md). stopWhen is a hard step count —
 * never isLoopFinished (plan's rejection list).
 *
 * Docs: node_modules/ai/docs/03-agents/02-building-agents.mdx
 */
export function buildWaveMidTurnAgent(params: WaveMidTurnAgentParams): WaveMidTurnAgentInstance {
  const toolkit = buildWaveMidTurnTools({ answeredQuestionIds: params.answeredQuestionIds });
  const { getConceptHistory, getDueConcepts } = buildWaveLookupTools({ courseId: params.courseId });
  // "full" mode lists every due concept in <due_for_review>, and SM-2 does
  // not move mid-Wave, so the due lookup would only burn a loop Step (audit
  // F4). "hint" mode keeps it: its hint asks the model to call it. The flag
  // is static per deploy, so the tool list stays cache-stable. Hint keeps
  // the pre-F4 order, so its request bytes do not change.
  const lookupTools: Pick<WaveMidTurnAgentTools, "getConceptHistory" | "getDueConcepts"> =
    WAVE.dueReviewInjection === "hint"
      ? { getDueConcepts, getConceptHistory }
      : { getConceptHistory };
  // Byte-identical to renderContext(seed).system: executeToolTurnStream drops
  // that system message, trusting the identity.
  const instructions = renderTeachingSystem(params.seed);
  const agent = new ToolLoopAgent({
    model: params.model ?? getLlmModel(),
    instructions,
    tools: { ...toolkit.tools, ...lookupTools },
    // Per-Step output cap. A Step that hits it fails the attempt (#181).
    maxOutputTokens: LLM.maxToolStepOutputTokens,
    stopWhen: [stepCountIs(LLM.maxToolSteps), lastStepHitOutputCap],
    temperature: LLM.defaultTemperature,
    maxRetries: LLM.maxRetries,
    // reasoning_effort and the Wave's prompt_cache_key on the wire, on
    // every loop Step.
    providerOptions: llmProviderOptions(params.waveId),
    prepareStep: cerebrasToolLoopPrepareStep,
    // Env-gated OTel span, stage-labelled, learner content redacted
    // (src/lib/llm/telemetry.ts). One span per turn, child spans per step.
    experimental_telemetry: llmTelemetry("wave-mid"),
    // After EVERY loop Step (each is one provider call): feed observed
    // x-ratelimit-* headers back to the pacing limiter, and fold the Step's
    // tokens into the per-run cost tally. The loop bypasses generateChat,
    // so this is the only place its usage is seen. Constructor-level so no
    // dispatch site can forget it.
    onStepFinish: (step) => {
      recordStepFinished(step.response.headers, step.usage);
    },
  });
  return { agent, collector: toolkit.collector, instructions };
}
