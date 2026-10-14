import type { TextStreamPart, ToolSet, UIMessageStreamWriter } from "ai";
import { executeToolTurnStream } from "@/lib/turn/executeToolTurnStream";
import { buildWaveMidTurnAgent } from "@/lib/agents/waveMidTurnAgent";
import { renderWaveTurnEnvelope, type WaveMidTurn } from "@/lib/prompts/waveTurn";
import type { ClientForwardedToolName, WaveTurnUIMessage } from "@/lib/types/waveStream";
import type { LlmUsage } from "@/lib/types/llm";
import { buildWaveSeed } from "./buildWaveSeed";
import {
  prepareWaveTurn,
  type PreparedWaveTurn,
  type PrepareWaveTurnParams,
} from "./prepareWaveTurn";
import { persistWaveMidTurn } from "./persistWaveMidTurn";
import { executeWaveClose } from "./executeWaveClose";
import type { WaveTurnCollector } from "./waveTurnTools";
import { findJsonProseLeakIndex } from "@/lib/turn/findJsonProseLeakIndex";
import { validateWaveMidToolTurn } from "./waveMidTurnGate";

/**
 * Runs one learner turn against an open Wave and streams it to the client.
 * Guards via prepareWaveTurn; persistence via persistWaveMidTurn /
 * executeWaveClose. Mid-turns dispatch through the wave mid-turn agent (`executeToolTurnStream`
 * + `buildWaveMidTurnAgent`, one fresh agent per attempt) — teaching prose
 * streams as plain text parts, structured actions arrive as tool calls
 * (only `presentQuestionnaire` is forwarded to the client, as typed tool
 * chunks for generative UI), the
 * finished-turn projection arrives as a transient `data-turn-result` part,
 * and validation retries emit a non-transient `data-turn-reset` marker part
 * (the client slices the message's parts on it).
 *
 * Close turns (turnsRemaining === 0) run BLOCKING inside the stream —
 * only the final data part is emitted. Streaming close prose is a noted
 * follow-up (issue #48).
 *
 * Returns the mid-turn loop's summed token usage (null on close turns) so
 * the live smoke can log token cost per turn — the Task-5 injection A/B
 * compares on it (docs/status/2026-07-08-agent-loop-cost-gate.md caveat).
 * The streaming route ignores the return value.
 */
export async function streamWaveTurn(
  params: PrepareWaveTurnParams,
  writer: UIMessageStreamWriter<WaveTurnUIMessage>,
): Promise<LlmUsage | null> {
  const prep: PreparedWaveTurn = await prepareWaveTurn(params);

  if (prep.isCloseTurn) {
    const result = await executeWaveClose(prep.dispatchCtx, prep.learnerInput);
    writer.write({ type: "data-turn-result", data: result, transient: true });
    return null;
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
  //   `finalText` (the last step's text only), because prose can land in
  //   any step. The prompt asks for tool calls first and the message after
  //   them, but the model may still write some prose before a call.
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

  // One seed serves both the context assembly (executeToolTurnStream) and
  // the agent's instructions — byte-identity between the two renders is what
  // lets the dispatcher drop the assembled system message (cache prefix).
  const seed = buildWaveSeed(prep.dispatchCtx.course, prep.dispatchCtx.wave);

  // The questions this turn answers, known before the loop starts. The
  // grading tool names any still ungraded, so the model completes a partial
  // call in-loop (issue #144). The post-loop gate stays the backstop.
  const answeredQuestionIds =
    prep.payload.kind === "questionnaire-answers" ? prep.payload.answers.map((a) => a.id) : [];

  // finalText deliberately unused: the learner-visible prose is accumulated
  // in attemptState (all steps, not just the closing step). usage is
  // surfaced to the caller for smoke-run cost logging only.
  const { usage } = await executeToolTurnStream({
    parent: { kind: "wave", id: prep.dispatchCtx.wave.id },
    seed,
    // Tool definitions ARE the schema channel on this path; the envelope
    // carries no schema.
    userMessageContent: renderWaveTurnEnvelope({
      learnerInput: prep.learnerInput,
      turnsRemaining: prep.turnsRemaining,
    }),
    makeAttempt: () => {
      // Fresh agent + collector per attempt — a retry must not inherit a
      // failed attempt's staged state (executeToolTurnStream contract). The
      // lookup tools are scoped to the server-resolved course by closure.
      const instance = buildWaveMidTurnAgent({
        seed,
        courseId: prep.dispatchCtx.course.id,
        answeredQuestionIds,
      });
      attemptState.collector = instance.collector;
      return {
        agent: instance.agent,
        // Gate over what the learner actually saw (attemptState.prose), not
        // the final step's text — see attemptState comment.
        validateTurn: () =>
          validateWaveMidToolTurn(instance.collector, attemptState.prose, prep.payload),
      };
    },
    onAttemptStart: (attempt) => {
      closeText();
      attemptState.prose = "";
      attemptState.suppressedAt = null;
      if (attempt > 0) {
        // NOT transient: the part must land INSIDE the assistant message's
        // parts array as a positional marker — the client renders only parts
        // AFTER the last reset (`deriveStreamingTurn`). Mid-stream setMessages surgery
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
      // an unfenced JSON-opening `{` (line-start, or followed by a quoted
      // key), withhold everything from that point for the rest of the
      // attempt. The gate then usually retries the turn; if it accepts
      // (false positive), the full prose still reaches the client via
      // chat_log on the turn-end refetch.
      if (attemptState.suppressedAt !== null) return;
      const leakAt = findJsonProseLeakIndex(attemptState.prose);
      if (leakAt === null) {
        writer.write({ type: "text-delta", id: textState.id, delta });
        return;
      }
      attemptState.suppressedAt = leakAt;
      // leakAt can fall BEHIND this delta (#156): a prior delta ended in
      // `{` with no verdict yet, and this one opens its quoted key. Then
      // max(0, …) forwards nothing. Only the `{` and its whitespace reached
      // the client, never a byte of the JSON body.
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

  // Adapt the collector to persistWaveMidTurn's input shape.
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
  return usage;
}

/**
 * Tools whose chunks cross the wire to the client (issue #59). Only
 * `presentQuestionnaire` has a consumer: the streamed quiz preview in
 * `deriveStreamingTurn`. Lookup results (SR state) and grading signals (verdicts)
 * have none, so they stay server-side. Typed by the client's tool-part
 * contract, so the set can never name a tool the client does not type.
 */
const CLIENT_FORWARDED_TOOLS: ReadonlySet<string> = new Set<ClientForwardedToolName>([
  "presentQuestionnaire",
]);

/**
 * The only `errorText` a forwarded tool's error chunk carries (#169). The
 * SDK error message quotes the whole tool input as JSON, answer key and
 * rubric included. The client never renders `errorText`, so the text stays
 * short. The model still reads the full error in-loop.
 */
const FORWARDED_TOOL_ERROR_TEXT = "The quiz could not be shown.";

/**
 * Map a `streamText` fullStream tool part to its UIMessage chunk and write it
 * — the same conversion the SDK's `toUIMessageStream` applies (verified in
 * installed ai@6.0.306), inlined because this route hand-writes its stream
 * AND because questionnaire inputs need server-side redaction before they
 * cross the wire (below). Gives the client the tool-part lifecycle for
 * generative UI: `input-available` → `output-available` (plus the error
 * states for schema-invalid inputs the model then self-corrects in-loop).
 *
 * DELIBERATE deviations from the SDK conversion:
 * - Only allowlisted tools forward (`CLIENT_FORWARDED_TOOLS`). Lookup and
 *   grading-signal chunks stay server-side (issue #59).
 * - `tool-input-delta` is NOT forwarded: the raw input text contains the
 *   plaintext `correct` key while it streams. The client renders from
 *   `input-available` (redacted) anyway.
 * - `presentQuestionnaire` inputs are redacted (grading keys stripped)
 *   before writing — the committed card gets `correctEnc` via `getState`
 *   (spec §7.8); the streamed preview must not leak more than that.
 * - Error chunks carry `FORWARDED_TOOL_ERROR_TEXT`, never the SDK error
 *   message, because that message quotes the tool input (#169).
 */
function forwardToolChunk<TOOLS extends ToolSet>(
  writer: UIMessageStreamWriter<WaveTurnUIMessage>,
  part: TextStreamPart<TOOLS>,
): void {
  // Allowlist gate. Every part type forwarded below carries `toolName`; the
  // two that lack it (tool-input-delta, tool-input-end) are never forwarded.
  // Dropping ALL of a tool's chunks keeps each forwarded toolCallId whole,
  // which the client's stream processor requires.
  if ("toolName" in part && !CLIENT_FORWARDED_TOOLS.has(part.toolName)) return;
  switch (part.type) {
    case "tool-input-start":
      writer.write({ type: "tool-input-start", toolCallId: part.id, toolName: part.toolName });
      return;
    case "tool-call":
      if (part.invalid === true) {
        // Redact here too: an invalid input can still contain a plaintext
        // `correct`; the client never needs the payload, only the error
        // state. The SDK message quotes the input, so it stays server-side.
        writer.write({
          type: "tool-input-error",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: null,
          errorText: FORWARDED_TOOL_ERROR_TEXT,
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
      // Fixed text too: for an invalid input this is the same SDK message,
      // and a thrown execute's message can quote the input as well.
      writer.write({
        type: "tool-output-error",
        toolCallId: part.toolCallId,
        errorText: FORWARDED_TOOL_ERROR_TEXT,
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
