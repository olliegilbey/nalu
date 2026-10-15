import type { StepResult, TextStreamPart, ToolSet } from "ai";
import { appendMessages } from "@/db/queries/contextMessages.writes";
import {
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
  type AppendMessageParams,
  type ContextParent,
} from "@/db/queries/contextMessages";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import { SCOPING } from "@/lib/config/tuning";
import { OUTPUT_TRUNCATED_RETRY_DIRECTIVE, renderHarnessFeedback } from "@/lib/prompts/turn";
import { toolStepRows } from "./toolStepRows";
import { findJsonProseLeakIndex } from "./findJsonProseLeakIndex";
import type { SeedInputs } from "@/lib/types/context";
import type { LlmMessage, LlmUsage } from "@/lib/types/llm";
import { assembleLlmMessages } from "./contextAssembly";

/**
 * Minimal agent surface the dispatcher needs — structurally satisfied by a
 * `ToolLoopAgent` from `src/lib/agents/` (whose `.stream()` resolves a
 * `StreamTextResult`), and by a canned stub in tests. Generic over the tool
 * set so a concrete agent's typed stream parts flow through to `onToolEvent`
 * without variance casts.
 *
 * CONTRACT: the agent carries the turn's system prompt as constructor
 * `instructions` (byte-identical to `renderContext(seed,…).system` — pinned
 * in waveMidTurnAgent.test.ts), plus model, tools, stopWhen, per-step pacing
 * (`prepareStep`), rate-limit header recording (`onStepFinish`), and a
 * silent stream `onError`: the SDK default logs the raw error (#173).
 */
export interface ToolTurnAgent<TOOLS extends ToolSet = ToolSet> {
  stream(options: { readonly messages: LlmMessage[] }): PromiseLike<{
    readonly fullStream: AsyncIterable<TextStreamPart<TOOLS>>;
    readonly steps: PromiseLike<ReadonlyArray<StepResult<TOOLS>>>;
    readonly totalUsage: PromiseLike<LlmUsage>;
  }>;
}

/**
 * One attempt's dispatch surface: a fresh agent (bound to a fresh collector
 * on the caller's side) plus the post-loop validation gate that inspects
 * that collector + the closing prose. A FACTORY rather than a static agent
 * because retries must not inherit a failed attempt's staged state.
 */
export interface ToolTurnAttempt<TOOLS extends ToolSet = ToolSet> {
  readonly agent: ToolTurnAgent<TOOLS>;
  /**
   * Post-loop validation (e.g. "free-text answers were submitted but
   * recordComprehensionSignals was never called"). Return null to accept;
   * a ValidationGateFailure to trigger the standard retry flow.
   */
  readonly validateTurn: (finalText: string) => ValidationGateFailure | null;
}

/** Inputs to {@link executeToolTurnStream}. */
export interface ExecuteToolTurnStreamParams<TOOLS extends ToolSet = ToolSet> {
  readonly parent: ContextParent;
  readonly seed: SeedInputs;
  /** Full pre-rendered user envelope (persisted verbatim as user_message). */
  readonly userMessageContent: string;
  /** Build a fresh agent + validation gate per attempt (0-based). */
  readonly makeAttempt: (attempt: number) => ToolTurnAttempt<TOOLS>;
  /** Called with each prose text delta as it streams (any loop step). */
  readonly onTextDelta: (delta: string, attempt: number) => void;
  /** Called before each attempt's stream starts (attempt is 0-based). */
  readonly onAttemptStart: (attempt: number) => void;
  /**
   * Tool lifecycle forwarding for generative UI (tool-input-start/-delta,
   * tool-call, tool-result, tool-error parts). Optional — persistence does
   * not depend on it.
   */
  readonly onToolEvent?: (part: TextStreamPart<TOOLS>, attempt: number) => void;
}

/** Result of a successful tool turn. The caller reads its collector for staged state. */
export interface ExecuteToolTurnStreamResult {
  /** Closing teaching prose (final step's text) — persisted as assistant_response. */
  readonly finalText: string;
  /** Token usage summed across all loop steps of the SUCCESSFUL attempt. */
  readonly usage: LlmUsage;
}

/** Stream part types forwarded to `onToolEvent`. */
const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
  "tool-result",
  "tool-error",
]);

/**
 * Tool-loop sibling of `executeTurn` (same skeleton: reserve turnIndex,
 * load priors, assemble messages, persist one atomic batch; same retry
 * budget). Differences:
 *
 * - The LLM call is `agent.stream({messages})` on the attempt's ToolLoopAgent
 *   (agent-loop plan Task 4): prose is plain streamed text (deltas forward
 *   as-is), structured actions arrive as tool calls staged by the agent's
 *   tool executes.
 * - The assembled message list's LEADING SYSTEM MESSAGE IS DROPPED before
 *   dispatch: the agent carries the identical bytes as constructor
 *   `instructions` (ToolLoopAgent maps instructions → system and passes
 *   messages through untouched — verified in installed ai@6.0.306); sending
 *   both would double the system prompt on the wire.
 * - Persisted rows for a successful turn: `user_message`, then per tool step
 *   an `assistant_tool_call` + `tool_result` pair, then `assistant_response`
 *   holding the closing prose. The Context replays the loop faithfully.
 * - Validation is the caller's post-loop gate (`validateTurn`), not a
 *   response schema. On failure the attempt persists ONE
 *   `failed_assistant_response` row + the usual `harness_retry_directive` —
 *   NOT tool-kind rows. WHY: renderContext's retry filter drops
 *   failed/directive kinds from recovered turns; persisting failed-attempt
 *   exhaust under the tool kinds would leak it into the recovered turn's
 *   rendered context and break the cache-prefix invariant ("a recovered turn
 *   renders identically to a non-retry turn").
 * - The failed row holds the prose the learner saw: every Step's text, cut
 *   at `findJsonProseLeakIndex` and trimmed ("" when nothing safe showed),
 *   or "" when a Step was cut off at the output cap (below). No tool trail
 *   (#140). The retry replays it as the model's previous
 *   reply, so a JSON reply there would prime the model to answer in JSON
 *   again. Staged tool state dies with the attempt, so replaying its tool
 *   results would also claim work the retry must redo. The directive
 *   already says to redo the tool calls.
 * - In-loop self-corrections (schema-invalid call → tool-error fed back →
 *   corrected call) are NOT harness retries; they stay inside one attempt's
 *   step trail. They persist only when that attempt succeeds: a failed
 *   attempt persists no tool trail (above).
 * - An abnormal loop end is a transport failure, not a gate failure: any
 *   `error` stream part rethrows its error, and no rows persist. A tool call
 *   with neither a result nor a tool-error throws `UnpairedToolCallError`
 *   (`toolStepRows`) rather than persist an orphan that Cerebras would
 *   reject on replay.
 * - A Step cut off at the output cap (`finishReason: "length"`; the agent
 *   sets `maxOutputTokens`) fails the attempt before the gate runs. It takes
 *   the gate-failure path as `output_truncated`, so the standard retry runs
 *   (#181). Its failed row is "": an unfinished reply never replays. Its
 *   tool trail never persists either. That matters for a cut-off INVALID
 *   call: the SDK answers it in-loop with an error that quotes the whole raw
 *   input, and replay must match those bytes, so persisting it would carry
 *   the runaway into every later Turn. The agent's `stopWhen` ends the loop
 *   right after the cut-off Step, so no Step runs on that error (#187). A
 *   cut-off VALID call never runs (ai 6.0.260+); this check comes first, so
 *   it retries instead of throwing `UnpairedToolCallError`.
 */
export async function executeToolTurnStream<TOOLS extends ToolSet = ToolSet>(
  params: ExecuteToolTurnStreamParams<TOOLS>,
): Promise<ExecuteToolTurnStreamResult> {
  const turnIndex = await getNextTurnIndex(params.parent);
  const priorRows =
    params.parent.kind === "wave"
      ? await getMessagesForWave(params.parent.id)
      : await getMessagesForScopingPass(params.parent.id);

  const userRow: AppendMessageParams = {
    parent: params.parent,
    turnIndex,
    seq: 0,
    kind: "user_message",
    role: "user",
    content: params.userMessageContent,
  };
  const totalAttempts = SCOPING.maxParseRetries + 1;

  async function attempt(
    i: number,
    batch: readonly AppendMessageParams[],
  ): Promise<ExecuteToolTurnStreamResult> {
    const llmMessages = assembleLlmMessages(params.seed, priorRows, batch);
    const { agent, validateTurn } = params.makeAttempt(i);
    params.onAttemptStart(i);

    // Drop the leading system message — the agent's `instructions` carries
    // the identical bytes (see the dispatch TSDoc above).
    const [head, ...rest] = llmMessages;
    const messages = head !== undefined && head.role === "system" ? rest : [...llmMessages];
    const result = await agent.stream({ messages });

    // Drain the stream: forward prose deltas and tool lifecycle events.
    // Tool-turn prose is plain text — no monotonic-prefix workaround needed.
    // `visibleProse` accumulates every Step's deltas: the learner-visible
    // prose, the same string the caller streams and gates. A failed attempt
    // replays as this prose (below). `let`: built up across the loop.
    let visibleProse = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        visibleProse += part.text;
        params.onTextDelta(part.text, i);
      } else if (TOOL_EVENT_TYPES.has(part.type)) {
        params.onToolEvent?.(part, i);
      } else if (part.type === "error") {
        // Any `error` part ends the attempt as a transport failure. The SDK
        // does not throw for them. A failed Step (transport/API error,
        // retries spent) emits one, closes the stream, and still RESOLVES
        // `steps` with the earlier Steps (ai@6.0.306). A provider chunk
        // error (openai-compatible) emits one WITHOUT closing the stream; it
        // is non-fatal to the SDK but still corrupts the attempt. So does a
        // provider stream that ends without a finish reason
        // (openai-compatible@2.0.82). A Step with no output at all emits one
        // and REJECTS `steps`; this throw comes first. Rethrow
        // the underlying error untouched, so the partial attempt never
        // reaches the gate or the DB — a transport failure persists no rows.
        throw part.error;
      }
    }

    const [steps, usage] = await Promise.all([result.steps, result.totalUsage]);
    // Closing prose = the FINAL step's text ("" when the loop ended on a
    // tool-call step); the caller's validation gate decides acceptability.
    const finalText = steps[steps.length - 1]?.text ?? "";
    // A Step cut off at the output cap fails the attempt before the gate
    // runs (#181; see the dispatch TSDoc).
    const truncated = steps.some((step) => step.finishReason === "length");
    const gate = truncated
      ? new ValidationGateFailure("output_truncated", OUTPUT_TRUNCATED_RETRY_DIRECTIVE)
      : validateTurn(finalText);

    if (gate === null) {
      // Success: persist the loop trail + closing prose in one atomic batch.
      const stepRowsAll = steps.reduce<readonly AppendMessageParams[]>(
        (acc, step) => [
          ...acc,
          ...toolStepRows(step, {
            parent: params.parent,
            turnIndex,
            seqStart: batch.length + acc.length,
          }),
        ],
        [],
      );
      const successRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length + stepRowsAll.length,
        kind: "assistant_response",
        role: "assistant",
        content: finalText,
      };
      await appendMessages([...batch, ...stepRowsAll, successRow]);
      return { finalText, usage };
    }

    // Validation failure: persist the attempt as the prose the learner saw,
    // cut at any JSON leak and trimmed (see TSDoc). "" when nothing safe
    // was shown, or when a Step was cut off: an unfinished reply never
    // replays. The row still marks the attempt in the Turn.
    const leakAt = findJsonProseLeakIndex(visibleProse);
    const shownProse = (leakAt === null ? visibleProse : visibleProse.slice(0, leakAt)).trim();
    const failedRow: AppendMessageParams = {
      parent: params.parent,
      turnIndex,
      seq: batch.length,
      kind: "failed_assistant_response",
      role: "assistant",
      content: truncated ? "" : shownProse,
    };
    if (i + 1 >= totalAttempts) {
      // Terminal exhaust: persist failure trail without trailing directive.
      await appendMessages([...batch, failedRow]);
      throw gate;
    }
    const directiveRow: AppendMessageParams = {
      parent: params.parent,
      turnIndex,
      seq: batch.length + 1,
      kind: "harness_retry_directive",
      role: "user",
      // The gate's detail is already a model-readable directive. The tag
      // marks it as Harness text to follow, not learner text (#123).
      content: renderHarnessFeedback(gate.detail),
    };
    return attempt(i + 1, [...batch, failedRow, directiveRow]);
  }

  return attempt(0, [userRow]);
}
