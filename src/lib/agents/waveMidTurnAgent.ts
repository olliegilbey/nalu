import { ToolLoopAgent, stepCountIs } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { getLlmModel } from "@/lib/llm/provider";
import { cerebrasToolLoopPrepareStep } from "@/lib/llm/streamToolChat";
import { LLM } from "@/lib/config/tuning";
import { renderTeachingSystem } from "@/lib/prompts/teaching";
import { buildWaveMidTurnTools, type WaveTurnCollector } from "@/lib/course/waveTurnTools";
import type { WaveSeedInputs } from "@/lib/types/context";
import { buildWaveLookupTools } from "./waveLookupTools";

/** Inputs that scope one agent instance to one wave turn. */
export interface WaveMidTurnAgentParams {
  /** Wave seed — renders the agent's instructions (system prompt). */
  readonly seed: WaveSeedInputs;
  /** Server-resolved course id; scopes the read-only lookup tools. */
  readonly courseId: string;
  /** Model override (tests); default: the provider singleton. */
  readonly model?: LanguageModelV3;
}

/** One built agent instance: agent + its turn-scoped collector + instructions. */
export interface WaveMidTurnAgentInstance {
  readonly agent: ToolLoopAgent<
    never,
    ReturnType<typeof buildWaveMidTurnTools>["tools"] & ReturnType<typeof buildWaveLookupTools>
  >;
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
 * reasoning strip). Built FRESH per attempt — collector and lookup scope are
 * closures over this turn; a retry must not inherit staged state.
 *
 * The agent NEVER sees XP and owns no stage transitions: it can look up
 * learner state and stage emissions; deterministic code does the rest
 * (Core Design Principle, AGENTS.md). stopWhen is a hard step count —
 * never isLoopFinished (plan's rejection list).
 *
 * Docs: node_modules/ai/docs/03-agents/02-building-agents.mdx
 */
export function buildWaveMidTurnAgent(params: WaveMidTurnAgentParams): WaveMidTurnAgentInstance {
  const toolkit = buildWaveMidTurnTools();
  const lookupTools = buildWaveLookupTools({ courseId: params.courseId });
  // The agent path IS the tool channel — force the "tools" prompt contract
  // so a caller's seed can't render mega-schema instructions into a tool loop.
  const instructions = renderTeachingSystem({ ...params.seed, outputContract: "tools" });
  const agent = new ToolLoopAgent({
    model: params.model ?? getLlmModel(),
    instructions,
    tools: { ...toolkit.tools, ...lookupTools },
    stopWhen: stepCountIs(LLM.maxToolSteps),
    temperature: LLM.defaultTemperature,
    maxRetries: LLM.maxRetries,
    prepareStep: cerebrasToolLoopPrepareStep,
  });
  return { agent, collector: toolkit.collector, instructions };
}
