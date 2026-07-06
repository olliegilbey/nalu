import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
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
  // Wire-side schema selection mirrors generateBaseline: strong models honour
  // strict-mode and receive the schema via response_format; weak models get
  // it inline in the envelope.
  const modelName = process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);
  const schemaJson = toSchemaJsonString(waveMidTurnSchema, { name: "wave_mid_turn" });

  const { parsed } = await executeTurn({
    parent: { kind: "wave", id: ctx.wave.id },
    seed: buildWaveSeed(ctx.course, ctx.wave),
    userMessageContent: renderWaveTurnEnvelope({
      learnerInput,
      turnsRemaining,
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
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
