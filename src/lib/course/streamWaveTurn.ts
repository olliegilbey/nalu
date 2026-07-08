import type { UIMessageStreamWriter } from "ai";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { executeTurnStream } from "@/lib/turn/executeTurnStream";
import { waveMidTurnSchema, renderWaveTurnEnvelope } from "@/lib/prompts/waveTurn";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";
import { buildWaveSeed } from "./buildWaveSeed";
import { prepareWaveTurn, type PreparedWaveTurn } from "./prepareWaveTurn";
import { persistWaveMidTurn } from "./persistWaveMidTurn";
import { executeWaveClose } from "./executeWaveClose";
import type { SubmitWaveTurnParams } from "./submitWaveTurn";

/**
 * Streaming counterpart of `submitWaveTurn`. Same guards (via
 * prepareWaveTurn), same persistence (via persistWaveMidTurn /
 * executeWaveClose); the difference is transport: teaching prose streams
 * as text parts, the finished-turn projection arrives as a transient
 * `data-turn-result` part, and validation retries emit `data-turn-reset`.
 *
 * Close turns (turnsRemaining === 0) run BLOCKING inside the stream —
 * only the final data part is emitted. Streaming close prose is a noted
 * follow-up (TODO.md).
 */
export async function streamWaveTurn(
  params: SubmitWaveTurnParams,
  writer: UIMessageStreamWriter<WaveTurnUIMessage>,
): Promise<void> {
  const prep: PreparedWaveTurn = await prepareWaveTurn(params);

  if (prep.isCloseTurn) {
    const result = await executeWaveClose(prep.dispatchCtx, prep.learnerInput);
    writer.write({ type: "data-turn-result", data: result, transient: true });
    return;
  }

  // Mirror executeWaveMid's schema/envelope setup (inline-schema fallback
  // for non-strict models stays at this layer — see modelCapabilities.ts).
  const capabilities = getModelCapabilities(process.env.LLM_MODEL ?? "(default)");
  const schemaJson = toSchemaJsonString(waveMidTurnSchema, { name: "wave_mid_turn" });

  // Each attempt streams under its own text id so the client can
  // distinguish a retry's fresh text from a continuation.
  const textState = { id: "", open: false };
  const closeText = () => {
    if (textState.open) {
      writer.write({ type: "text-end", id: textState.id });
      textState.open = false;
    }
  };

  const { parsed } = await executeTurnStream({
    parent: { kind: "wave", id: prep.dispatchCtx.wave.id },
    seed: buildWaveSeed(prep.dispatchCtx.course, prep.dispatchCtx.wave),
    userMessageContent: renderWaveTurnEnvelope({
      learnerInput: prep.learnerInput,
      turnsRemaining: prep.turnsRemaining,
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
    }),
    responseSchema: waveMidTurnSchema,
    responseSchemaName: "wave_mid_turn",
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "wave-mid",
    progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
    onAttemptStart: (attempt) => {
      closeText();
      if (attempt > 0) {
        writer.write({ type: "data-turn-reset", data: { attempt }, transient: true });
      }
      textState.id = `wave-turn-text-${attempt}`;
      writer.write({ type: "text-start", id: textState.id });
      textState.open = true;
    },
    onTextDelta: (delta) => {
      writer.write({ type: "text-delta", id: textState.id, delta });
    },
  });
  closeText();

  const result = await persistWaveMidTurn({
    ctx: prep.dispatchCtx,
    parsed,
    payload: prep.payload,
    turnsRemaining: prep.turnsRemaining,
  });
  writer.write({ type: "data-turn-result", data: result, transient: true });
}
