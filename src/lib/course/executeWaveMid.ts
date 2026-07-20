import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { waveMidTurnSchema, renderWaveTurnEnvelope } from "@/lib/prompts/waveTurn";
import { type SubmitTurnPayload } from "./buildLearnerInput";
import { buildWaveSeed } from "./buildWaveSeed";
import type { LoadedWaveContext } from "./loadWaveContext";
import { persistWaveMidTurn, type ExecuteWaveMidResult } from "./persistWaveMidTurn";
import type { NewQuestionnaireProjection } from "./executeWaveMid.insert";

export type { NewQuestionnaireProjection, ExecuteWaveMidResult };

/**
 * Per-turn orchestration for a mid-Wave teaching turn (spec §3.3), blocking
 * transport. Flow: schema/envelope setup → `executeTurn` (persists
 * `user_message + assistant_response` at a fresh turn_index) →
 * `persistWaveMidTurn` (grading + questionnaire insert + chat_log dual-write,
 * one transaction — shared with the streaming path).
 */
export async function executeWaveMid(
  ctx: LoadedWaveContext,
  learnerInput: string,
  turnsRemaining: number,
  payload: SubmitTurnPayload,
): Promise<ExecuteWaveMidResult> {
  // Schema string retained only for the retry directive — the wire-side
  // `response_format` carries the schema on every normal turn.
  const schemaJson = toSchemaJsonString(waveMidTurnSchema, { name: "wave_mid_turn" });

  const { parsed } = await executeTurn({
    parent: { kind: "wave", id: ctx.wave.id },
    // "json": this is the blocking mega-schema path — the system prompt must
    // keep declaring the single-JSON output contract.
    seed: buildWaveSeed(ctx.course, ctx.wave, "json"),
    userMessageContent: renderWaveTurnEnvelope({
      learnerInput,
      turnsRemaining,
    }),
    responseSchema: waveMidTurnSchema,
    responseSchemaName: "wave_mid_turn",
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "wave-mid",
    successSummary: (p) =>
      `signals=${p.comprehensionSignals?.length ?? 0} questionnaire=${p.questionnaire ? p.questionnaire.questions.length : 0}`,
  });

  return persistWaveMidTurn({ ctx, parsed, payload, turnsRemaining });
}
