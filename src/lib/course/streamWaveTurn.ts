import type { TextStreamPart, ToolSet, UIMessageStreamWriter } from "ai";
import { executeToolTurnStream } from "@/lib/turn/executeToolTurnStream";
import { renderWaveTurnEnvelope, type WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";
import { buildWaveSeed } from "./buildWaveSeed";
import { prepareWaveTurn, type PreparedWaveTurn } from "./prepareWaveTurn";
import { persistWaveMidTurn } from "./persistWaveMidTurn";
import { executeWaveClose } from "./executeWaveClose";
import { buildWaveMidTurnTools, type WaveTurnCollector } from "./waveTurnTools";
import { validateWaveMidToolTurn } from "./waveMidTurnGate";
import type { SubmitWaveTurnParams } from "./submitWaveTurn";

/**
 * Streaming counterpart of `submitWaveTurn`. Same guards (via
 * prepareWaveTurn), same persistence (via persistWaveMidTurn /
 * executeWaveClose); the difference is transport AND emission channel:
 * mid-turns run a `streamText` tool loop (`executeToolTurnStream` +
 * `buildWaveMidTurnTools`) — teaching prose streams as plain text parts,
 * structured actions arrive as tool calls forwarded to the client as typed
 * tool chunks (generative UI), the finished-turn projection arrives as a
 * transient `data-turn-result` part, and validation retries emit
 * `data-turn-reset`.
 *
 * The blocking tRPC path (`executeWaveMid`) keeps the mega-schema JSON
 * contract as the rollback transport — shared pieces are prepareWaveTurn
 * and persistWaveMidTurn, not the LLM dispatch.
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
    // "tools" keeps the close turn's system prompt byte-identical to the
    // mid turns' (cache prefix) — the close call itself is still single-JSON.
    const result = await executeWaveClose(prep.dispatchCtx, prep.learnerInput, "tools");
    writer.write({ type: "data-turn-result", data: result, transient: true });
    return;
  }

  // Each attempt streams under its own text id so the client can
  // distinguish a retry's fresh text from a continuation.
  const textState = { id: "", open: false };
  const closeText = () => {
    if (textState.open) {
      writer.write({ type: "text-end", id: textState.id });
      textState.open = false;
    }
  };

  // Per-attempt mutable slots, reset by makeAttempt/onAttemptStart. After the
  // loop resolves they hold the SUCCESSFUL attempt's state:
  // - collector: tool-staged questionnaire + grading signals.
  // - prose: every text delta the client saw this attempt, concatenated. This
  //   is the learner-visible message (chat_log / turn-result) — deliberately
  //   NOT `finalText` (the last step's text only), because models typically
  //   write prose BEFORE a tool call and only a short wrap-up after it.
  const attemptState: { collector: WaveTurnCollector; prose: string } = {
    collector: { questionnaire: null, signals: [] },
    prose: "",
  };

  // Result deliberately unused: the learner-visible prose is accumulated in
  // attemptState (all steps), and usage is dropped here exactly as the
  // blocking path drops executeTurn's.
  await executeToolTurnStream({
    parent: { kind: "wave", id: prep.dispatchCtx.wave.id },
    seed: buildWaveSeed(prep.dispatchCtx.course, prep.dispatchCtx.wave, "tools"),
    // No inline responseSchema block: tool definitions ARE the schema channel
    // on this path (the envelope's param stays alive for the blocking path).
    userMessageContent: renderWaveTurnEnvelope({
      learnerInput: prep.learnerInput,
      turnsRemaining: prep.turnsRemaining,
    }),
    makeAttempt: () => {
      // Fresh tools + collector per attempt — a retry must not inherit a
      // failed attempt's staged state (executeToolTurnStream contract).
      const toolkit = buildWaveMidTurnTools();
      attemptState.collector = toolkit.collector;
      return {
        tools: toolkit.tools,
        // Gate over what the learner actually saw (attemptState.prose), not
        // the final step's text — see attemptState comment.
        validateTurn: () =>
          validateWaveMidToolTurn(toolkit.collector, attemptState.prose, prep.payload),
      };
    },
    onAttemptStart: (attempt) => {
      closeText();
      attemptState.prose = "";
      if (attempt > 0) {
        writer.write({ type: "data-turn-reset", data: { attempt }, transient: true });
      }
      textState.id = `wave-turn-text-${attempt}`;
      writer.write({ type: "text-start", id: textState.id });
      textState.open = true;
    },
    onTextDelta: (delta) => {
      attemptState.prose += delta;
      writer.write({ type: "text-delta", id: textState.id, delta });
    },
    onToolEvent: (part) => {
      forwardToolChunk(writer, part);
    },
  });
  closeText();

  // Adapt the collector to persistWaveMidTurn's EXISTING input shape (the old
  // parsed mega-schema object) — persistence stays byte-for-byte shared with
  // the blocking path so grading/XP semantics cannot drift.
  const parsed: WaveMidTurn = {
    userMessage: attemptState.prose,
    comprehensionSignals:
      attemptState.collector.signals.length > 0 ? attemptState.collector.signals : undefined,
    questionnaire: attemptState.collector.questionnaire ?? undefined,
  };

  const result = await persistWaveMidTurn({
    ctx: prep.dispatchCtx,
    parsed,
    payload: prep.payload,
    turnsRemaining: prep.turnsRemaining,
  });
  writer.write({ type: "data-turn-result", data: result, transient: true });
}

/**
 * Map a `streamText` fullStream tool part to its UIMessage chunk and write it
 * — the same conversion the SDK's `toUIMessageStream` applies (verified in
 * installed ai@6.0.158), inlined because this route hand-writes its stream.
 * Gives the client the standard tool-part lifecycle for generative UI:
 * `input-streaming` → `input-available` → `output-available` (or the error
 * states for schema-invalid inputs the model then self-corrects in-loop).
 */
function forwardToolChunk(
  writer: UIMessageStreamWriter<WaveTurnUIMessage>,
  part: TextStreamPart<ToolSet>,
): void {
  switch (part.type) {
    case "tool-input-start":
      writer.write({ type: "tool-input-start", toolCallId: part.id, toolName: part.toolName });
      return;
    case "tool-input-delta":
      writer.write({ type: "tool-input-delta", toolCallId: part.id, inputTextDelta: part.delta });
      return;
    case "tool-call":
      if (part.invalid === true) {
        writer.write({
          type: "tool-input-error",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          errorText: String(part.error),
        });
        return;
      }
      writer.write({
        type: "tool-input-available",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      });
      return;
    case "tool-result":
      writer.write({
        type: "tool-output-available",
        toolCallId: part.toolCallId,
        output: part.output,
      });
      return;
    case "tool-error":
      writer.write({
        type: "tool-output-error",
        toolCallId: part.toolCallId,
        errorText: String(part.error),
      });
      return;
    default:
      // tool-input-end has no UIMessage chunk equivalent (input-available
      // carries the full input); other part types never reach onToolEvent.
      return;
  }
}
