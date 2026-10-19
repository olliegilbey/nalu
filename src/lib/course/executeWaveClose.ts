import { executeTurn } from "@/lib/turn/executeTurn";
import { makeWaveCloseSchema, renderWaveCloseEnvelope } from "@/lib/prompts/waveClose";
import {
  getFreshConcepts,
  getDueConcepts,
  renderConceptInjection,
} from "@/lib/spaced-repetition/scheduler";
import { getConceptsByCourse } from "@/db/queries/concepts";
import type { FrameworkJsonb } from "@/lib/types/jsonb";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { buildWaveSeed } from "./buildWaveSeed";
import { logWaveCloseGradings } from "./closeGradingDebug";
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
import { persistWaveClose, type PersistedGradedSignal } from "./persistWaveClose";
import type { LoadedWaveContext } from "./loadWaveContext";

/**
 * Per-close orchestration result, streamed to the client as the
 * `data-turn-result` part. The discriminator `kind` puts mid-turn and
 * close-turn results under one union (`WaveTurnResultData`, spec §3.3).
 */
export interface ExecuteWaveCloseResult {
  readonly kind: "close-turn";
  /** Closing chat message the learner sees (`parsed.userMessage`). */
  readonly closingMessage: string;
  /** Row id of the just-opened Wave N+1. The client uses it to redirect/refresh. */
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
 *      close Wave N (throws PRECONDITION_FAILED if it was already closed) →
 *      gradings → SM-2 → course summary → tier check → open Wave N+1 → seed
 *      opening message → bump total_xp.
 *
 * No redaction step is needed: a close turn emits no questionnaire, so the
 * result carries no answer keys.
 */
export async function executeWaveClose(
  ctx: LoadedWaveContext,
  learnerInput: string,
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
  // `loadWaveContext` no longer carries it. Used here to scope the schema's
  // `questionIds` superRefine to the latest open card (and by the debug log).
  const openQuestionnaire = findOpenQuestionnaire(ctx.wave.chatLog as WaveChatLog);
  const questionIds = openQuestionnaire?.questions.map((q) => q.id) ?? [];
  const schema = makeWaveCloseSchema({
    scopeTiers: framework.tiers.map((t) => t.number),
    questionIds,
    freshConceptNames: fresh.map((c) => c.name),
    reviewDueNames: due.map((c) => c.name),
    existingConceptNames: allConcepts.map((c) => c.name),
  });

  const conceptsBlock = renderConceptInjection(fresh, due);

  // The close turn itself is single-JSON (blocking executeTurn +
  // response_format), but it renders the same system prompt as the mid
  // turns, so the provider cache prefix survives the mid→close switch.
  const { parsed } = await executeTurn({
    parent: { kind: "wave", id: ctx.wave.id },
    seed: buildWaveSeed(ctx.course, ctx.wave),
    userMessageContent: renderWaveCloseEnvelope({
      learnerInput,
      conceptsForNextWaveBlock: conceptsBlock,
    }),
    responseSchema: schema,
    responseSchemaName: "wave_close",
    label: "wave-close",
    successSummary: (p) =>
      `gradings=${p.gradings.length} updates=${p.conceptUpdates.length} planned=${p.nextUnitBlueprint.plannedConcepts.length}`,
  });

  // Issue #22 diagnosis: no-op unless LLM_DEBUG_GRADINGS is on, and never
  // throws. Runs after Zod parse, before persistence. Each line pairs the
  // model's grading kind with the learner's Response kind: a freetext
  // Response graded `mc-index` is the silent 0-XP path, and `q=0`/`q=1`
  // (`xp≈0`) is hypothesis (2). An omitted grading never gets here — the
  // coverage refine rejects it, so it shows as a parse-failure line.
  await logWaveCloseGradings({
    waveId: ctx.wave.id,
    openQuestionnaireId: openQuestionnaire?.questionnaireId,
    questionIds,
    gradings: parsed.gradings,
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
