import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
import { makeWaveCloseSchema, renderWaveCloseEnvelope } from "@/lib/prompts/waveClose";
import {
  getFreshConcepts,
  getDueConcepts,
  renderConceptInjection,
} from "@/lib/spaced-repetition/scheduler";
import { getConceptsByCourse } from "@/db/queries/concepts";
import type { WaveOutputContract } from "@/lib/types/context";
import type { FrameworkJsonb } from "@/lib/types/jsonb";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { buildWaveSeed } from "./buildWaveSeed";
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
import { persistWaveClose, type PersistedGradedSignal } from "./persistWaveClose";
import type { LoadedWaveContext } from "./loadWaveContext";

/**
 * Per-close orchestration result. The router projects this to the client-safe
 * shape; the discriminator `kind` lets `submitWaveTurn` return either
 * mid-turn or close-turn under one union (spec §3.3).
 */
export interface ExecuteWaveCloseResult {
  readonly kind: "close-turn";
  /** Closing chat message the learner sees (`parsed.userMessage`). */
  readonly closingMessage: string;
  /** Row id of the just-opened Wave N+1. `submitWaveTurn` uses it to redirect/refresh the client. */
  readonly nextWaveId: string;
  /** Ordinal of the just-opened Wave N+1. */
  readonly nextWaveNumber: number;
  /** Flat completion XP applied to total_xp (always `WAVE.completionXp`). */
  readonly completionXpAwarded: number;
  /** New currentTier if the tier-advancement check fired and passed; else null. */
  readonly tierAdvancedTo: number | null;
  /** Per-question grading projection. Empty when no questions were graded. */
  readonly gradedSignals: readonly PersistedGradedSignal[];
}

/**
 * Per-Wave-close orchestration (spec §3.3).
 *
 * Flow:
 *   1. Build the close-turn schema. `scopeTiers` / `questionIds` /
 *      `freshConceptNames` / `reviewDueNames` / `existingConceptNames` are
 *      closed over the wave's framework + open questionnaire + concept state.
 *      The schema's superRefines fail loud on out-of-scope tiers, missing
 *      question ids, and unknown concept names in `conceptUpdates`.
 *   2. Dispatch `executeTurn` against the close schema. The harness persists
 *      `user_message + assistant_response` at a freshly-allocated turn_index.
 *   3. Delegate to `persistWaveClose` for the all-or-nothing transaction:
 *      gradings → SM-2 → close Wave N → tier check → open Wave N+1 → seed
 *      opening message → bump total_xp.
 *
 * The orchestrator stops short of the redaction step — `submitWaveTurn`
 * (Task 13) is responsible for projecting the persisted result to the
 * client-safe shape (no questionnaire is emitted on a close turn).
 */
export async function executeWaveClose(
  ctx: LoadedWaveContext,
  learnerInput: string,
  // The close turn itself is ALWAYS single-JSON (blocking executeTurn +
  // response_format); the contract only selects which system prompt the
  // whole Wave renders under. The streaming transport passes "tools" so the
  // close turn's system prompt is byte-identical to the mid turns' — the
  // provider cache prefix survives the mid→close switch. Default "json"
  // keeps the blocking rollback path and existing tests untouched.
  outputContract: WaveOutputContract = "json",
): Promise<ExecuteWaveCloseResult> {
  const now = new Date();

  // Pre-tx reads to build the schema. These don't need transactional visibility
  // because the schema only constrains the model's output shape; the actual
  // persistence reads re-fetch via the tx so any racing write is observed.
  const allConcepts = await getConceptsByCourse(ctx.course.id);
  const fresh = await getFreshConcepts(ctx.course.id, ctx.wave.tier);
  const due = await getDueConcepts(ctx.course.id, now);

  // Wave JSONB columns are validated upstream by `waveRowGuard` so the cast
  // here is safe — Drizzle widens JSONB to `unknown` but the runtime shape is
  // guaranteed.
  const framework = ctx.wave.frameworkSnapshot as FrameworkJsonb;
  // Open questionnaire is derived from chat_log per the new contract —
  // `loadWaveContext` no longer carries it. Used here only to scope the
  // schema's `questionIds` superRefine to the latest open card.
  const openQuestionnaire = findOpenQuestionnaire(ctx.wave.chatLog as WaveChatLog);
  const schema = makeWaveCloseSchema({
    scopeTiers: framework.tiers.map((t) => t.number),
    questionIds: openQuestionnaire?.questions.map((q) => q.id) ?? [],
    freshConceptNames: fresh.map((c) => c.name),
    reviewDueNames: due.map((c) => c.name),
    existingConceptNames: allConcepts.map((c) => c.name),
  });

  // Wire-side schema selection mirrors executeWaveMid: strong models honour
  // strict-mode and receive the schema via response_format; weak models get
  // it inline in the envelope so they can self-check.
  const modelName = process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);
  const schemaJson = toSchemaJsonString(schema, { name: "wave_close" });
  const conceptsBlock = renderConceptInjection(fresh, due);

  const { parsed } = await executeTurn({
    parent: { kind: "wave", id: ctx.wave.id },
    seed: buildWaveSeed(ctx.course, ctx.wave, outputContract),
    userMessageContent: renderWaveCloseEnvelope({
      learnerInput,
      conceptsForNextWaveBlock: conceptsBlock,
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
    }),
    responseSchema: schema,
    responseSchemaName: "wave_close",
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "wave-close",
    successSummary: (p) =>
      `gradings=${p.gradings.length} updates=${p.conceptUpdates.length} planned=${p.nextUnitBlueprint.plannedConcepts.length}`,
  });

  // Delegate to the transactional persistence body. Throws on any rollback;
  // executeTurn's user/assistant rows have already been persisted by the time
  // we reach persistence (they're outside this tx — the harness commits them
  // atomically as a sibling write batch). That's plan-faithful with the
  // mid-turn flow.
  const persisted = await persistWaveClose({ ctx, parsed, now });

  return {
    kind: "close-turn",
    closingMessage: parsed.userMessage,
    nextWaveId: persisted.nextWaveId,
    nextWaveNumber: persisted.nextWaveNumber,
    completionXpAwarded: persisted.completionXpAwarded,
    tierAdvancedTo: persisted.tierAdvancedTo,
    gradedSignals: persisted.gradedSignals,
  };
}
