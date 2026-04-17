import { generateStructured } from "@/lib/llm/generate";
import {
  baselineSchema,
  buildBaselinePrompt,
  type BaselineQuestion,
  type ClarificationExchange,
  type Framework,
} from "@/lib/prompts";
import type { LlmUsage } from "@/lib/types/llm";

/** Params for {@link generateBaseline}. Mirrors `buildBaselinePrompt` inputs. */
export interface GenerateBaselineParams {
  /** Raw, untrusted topic. Sanitised inside the prompt builder. */
  readonly topic: string;
  /** Q&A from the clarification turn. Answers sanitised downstream. */
  readonly clarifications: readonly ClarificationExchange[];
  /** Trusted framework from the framework-generation turn. */
  readonly framework: Framework;
}

/**
 * Result of a baseline-generation turn. `scopeTiers` and
 * `estimatedStartingTier` are surfaced as first-class fields (even though
 * they're already on `framework`) because downstream consumers
 * (`gradeBaseline`, `determineStartingTier`, UI progress bar) need them
 * without re-reading the full framework.
 */
export interface GenerateBaselineResult {
  readonly questions: readonly BaselineQuestion[];
  readonly scopeTiers: readonly number[];
  readonly estimatedStartingTier: number;
  readonly usage: LlmUsage;
}

/**
 * Drive the baseline-generation turn (PRD §4.1 step 3).
 *
 * Thin orchestrator over the continuation-history prompt builder:
 * `buildBaselinePrompt` reconstructs the scoping conversation up through
 * the new baseline-task user message, hands it to `generateStructured`
 * with `baselineSchema`, then we assert two orchestrator-level
 * invariants the Zod schema can't express on its own:
 *
 * 1. Every question's `tier` is one of `framework.baselineScopeTiers`.
 *    P-ON-02 at runtime: the schema enforces a tier is a positive int,
 *    but not that it sits inside the scope the prompt specified.
 * 2. Question IDs are unique within the batch. Duplicate IDs would
 *    break the mechanical/LLM grader split downstream.
 *
 * Invariant failures are hard errors — surfaced, not patched — because
 * they indicate an LLM that stopped obeying the prompt contract.
 */
export async function generateBaseline(
  params: GenerateBaselineParams,
): Promise<GenerateBaselineResult> {
  const messages = buildBaselinePrompt({
    topic: params.topic,
    clarifications: params.clarifications,
    framework: params.framework,
  });
  const { object, usage } = await generateStructured(baselineSchema, messages);

  const outOfScope = object.questions.filter(
    (q: BaselineQuestion) => !params.framework.baselineScopeTiers.includes(q.tier),
  );
  if (outOfScope.length > 0) {
    const ids = outOfScope.map((q) => `${q.id}(tier=${q.tier})`).join(", ");
    throw new Error(`baseline questions outside baselineScopeTiers: ${ids}`);
  }

  // Functional duplicate scan: indexOf's first-occurrence semantics means
  // any id whose later index differs from its first is a duplicate. Avoids
  // the mutable-Set pattern `functional/immutable-data` flags.
  const allIds = object.questions.map((q) => q.id);
  const duplicates = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new Error(`baseline question ids are not unique: ${duplicates.join(", ")}`);
  }

  return {
    questions: object.questions,
    scopeTiers: params.framework.baselineScopeTiers,
    estimatedStartingTier: params.framework.estimatedStartingTier,
    usage,
  };
}
