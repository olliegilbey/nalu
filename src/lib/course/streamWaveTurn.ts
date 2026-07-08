import type { TextStreamPart, ToolSet, UIMessageStreamWriter } from "ai";
import { executeToolTurnStream } from "@/lib/turn/executeToolTurnStream";
import { renderWaveTurnEnvelope, type WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";
import { buildWaveSeed } from "./buildWaveSeed";
import { prepareWaveTurn, type PreparedWaveTurn } from "./prepareWaveTurn";
import { persistWaveMidTurn } from "./persistWaveMidTurn";
import { executeWaveClose } from "./executeWaveClose";
import { buildWaveMidTurnTools, type WaveTurnCollector } from "./waveTurnTools";
import { findJsonProseLeakIndex, validateWaveMidToolTurn } from "./waveMidTurnGate";
import type { SubmitWaveTurnParams } from "./submitWaveTurn";

/**
 * Streaming counterpart of `submitWaveTurn`. Same guards (via
 * prepareWaveTurn), same persistence (via persistWaveMidTurn /
 * executeWaveClose); the difference is transport AND emission channel:
 * mid-turns run a `streamText` tool loop (`executeToolTurnStream` +
 * `buildWaveMidTurnTools`) — teaching prose streams as plain text parts,
 * structured actions arrive as tool calls forwarded to the client as typed
 * tool chunks (generative UI), the finished-turn projection arrives as a
 * transient `data-turn-result` part, and validation retries emit a
 * non-transient `data-turn-reset` marker part (the client slices the
 * message's parts on it).
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
  // - prose: every text delta of this attempt, concatenated. This is the
  //   learner-visible message (chat_log / turn-result) — deliberately NOT
  //   `finalText` (the last step's text only), because models typically
  //   write prose BEFORE a tool call and only a short wrap-up after it.
  // - suppressedAt: leak-guard cut point (see onTextDelta). Deltas past it
  //   are withheld from the CLIENT only; prose keeps accumulating for the
  //   gate and persistence.
  const attemptState: {
    collector: WaveTurnCollector;
    prose: string;
    suppressedAt: number | null;
  } = {
    collector: { questionnaire: null, signals: [] },
    prose: "",
    suppressedAt: null,
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
      attemptState.suppressedAt = null;
      if (attempt > 0) {
        // NOT transient: the part must land INSIDE the assistant message's
        // parts array as a positional marker — the client renders only parts
        // AFTER the last reset (useWaveState). Mid-stream setMessages surgery
        // does not work: the SDK re-emits its internally accumulated message
        // (stale parts included) on the next chunk.
        writer.write({ type: "data-turn-reset", data: { attempt } });
      }
      textState.id = `wave-turn-text-${attempt}`;
      writer.write({ type: "text-start", id: textState.id });
      textState.open = true;
    },
    onTextDelta: (delta) => {
      const priorLength = attemptState.prose.length;
      attemptState.prose += delta;
      // Leak guard: a JSON-imitation attempt dumps the would-be tool input —
      // plaintext `correct` included — into the TEXT channel, bypassing all
      // tool-chunk redaction (observed live). Once the accumulated prose hits
      // an unfenced line-start `{`, withhold everything from that point for
      // the rest of the attempt. The gate then usually retries the turn; if
      // it accepts (false positive), the full prose still reaches the client
      // via chat_log on the turn-end refetch.
      if (attemptState.suppressedAt !== null) return;
      const leakAt = findJsonProseLeakIndex(attemptState.prose);
      if (leakAt === null) {
        writer.write({ type: "text-delta", id: textState.id, delta });
        return;
      }
      attemptState.suppressedAt = leakAt;
      const safe = delta.slice(0, Math.max(0, leakAt - priorLength));
      if (safe.length > 0) {
        writer.write({ type: "text-delta", id: textState.id, delta: safe });
      }
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
 * installed ai@6.0.158), inlined because this route hand-writes its stream
 * AND because questionnaire inputs need server-side redaction before they
 * cross the wire (below). Gives the client the tool-part lifecycle for
 * generative UI: `input-available` → `output-available` (plus the error
 * states for schema-invalid inputs the model then self-corrects in-loop).
 *
 * DELIBERATE deviations from the SDK conversion:
 * - `tool-input-delta` is NOT forwarded: the raw input text contains the
 *   plaintext `correct` key while it streams. The client renders from
 *   `input-available` (redacted) anyway.
 * - `presentQuestionnaire` inputs are redacted (grading keys stripped)
 *   before writing — the committed card gets `correctEnc` via `getState`
 *   (spec §7.8); the streamed preview must not leak more than that.
 */
function forwardToolChunk(
  writer: UIMessageStreamWriter<WaveTurnUIMessage>,
  part: TextStreamPart<ToolSet>,
): void {
  switch (part.type) {
    case "tool-input-start":
      writer.write({ type: "tool-input-start", toolCallId: part.id, toolName: part.toolName });
      return;
    case "tool-call":
      if (part.invalid === true) {
        // Redact here too: an invalid input can still contain a plaintext
        // `correct`; the client never needs the payload, only the error.
        writer.write({
          type: "tool-input-error",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: null,
          errorText: String(part.error),
        });
        return;
      }
      writer.write({
        type: "tool-input-available",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input:
          part.toolName === "presentQuestionnaire"
            ? redactQuestionnaireInput(part.input)
            : part.input,
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
      // tool-input-end has no UIMessage chunk equivalent; tool-input-delta is
      // deliberately dropped (see TSDoc); other part types never reach
      // onToolEvent.
      return;
  }
}

/**
 * Allowlist-project a validated `presentQuestionnaire` input to the fields
 * the client card needs (id/type/prompt/options/tier), dropping the grading
 * keys (`correct`, `freetextRubric` — "[server] NEVER shown to the learner").
 * Structural rather than schema-bound so a shape drift forwards LESS, never
 * more. Returns null when the shape is unrecognisable.
 */
function redactQuestionnaireInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("questions" in input)) return null;
  const questions = (input as { questions: unknown }).questions;
  if (!Array.isArray(questions)) return null;
  return {
    questions: questions.map((q) => {
      if (typeof q !== "object" || q === null) return null;
      const rec = q as Record<string, unknown>;
      return {
        id: rec["id"],
        type: rec["type"],
        prompt: rec["prompt"],
        options: rec["options"],
        tier: rec["tier"],
      };
    }),
  };
}
