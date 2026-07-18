import type { StepResult, TextStreamPart, ToolSet } from "ai";
import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
  type AppendMessageParams,
  type ContextParent,
} from "@/db/queries/contextMessages";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import { SCOPING } from "@/lib/config/tuning";
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
 * (`prepareStep`) and rate-limit header recording (`onStepFinish`).
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
  /** Directive text for the retry row. Default: the gate failure's detail. */
  readonly retryDirective?: (err: ValidationGateFailure, attempt: number) => string;
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
 * Tool-loop sibling of `executeTurnStream` (same skeleton: reserve turnIndex,
 * load priors, assemble messages, persist one atomic batch; same retry
 * budget). Differences:
 *
 * - The LLM call is `agent.stream({messages})` on the attempt's ToolLoopAgent
 *   (agent-loop plan Task 4): prose is plain streamed text (no partial-JSON
 *   projection — deltas forward as-is), structured actions arrive as tool
 *   calls staged by the agent's tool executes.
 * - The assembled message list's LEADING SYSTEM MESSAGE IS DROPPED before
 *   dispatch: the agent carries the identical bytes as constructor
 *   `instructions` (ToolLoopAgent maps instructions → system and passes
 *   messages through untouched — verified in installed ai@6.0.158); sending
 *   both would double the system prompt on the wire.
 * - Persisted rows for a successful turn: `user_message`, then per tool step
 *   an `assistant_tool_call` + `tool_result` pair, then `assistant_response`
 *   holding the closing prose. The Context replays the loop faithfully.
 * - Validation is the caller's post-loop gate (`validateTurn`), not a
 *   response schema. On failure the attempt persists ONE
 *   `failed_assistant_response` row whose content is a JSON envelope of the
 *   attempt exhaust (`{text, steps:[{toolCalls, results}]}`) + the usual
 *   `harness_retry_directive` — NOT tool-kind rows. WHY: renderContext's
 *   retry filter drops failed/directive kinds from recovered turns; persisting
 *   failed-attempt exhaust under the tool kinds would leak it into the
 *   recovered turn's rendered context and break the cache-prefix invariant
 *   ("a recovered turn renders identically to a non-retry turn"). The JSON
 *   envelope keeps the audit trail and gives the retry attempt full context.
 * - In-loop self-corrections (schema-invalid call → tool-error fed back →
 *   corrected call) are NOT harness retries; they stay inside one attempt's
 *   step trail and persist with it.
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
  const directiveFn = params.retryDirective ?? ((err) => err.detail);

  /** Map one loop step to its persisted row pair (empty for pure-text steps). */
  function stepRows(step: StepResult<TOOLS>, seqStart: number): readonly AppendMessageParams[] {
    if (step.toolCalls.length === 0) return [];
    const callRow: AppendMessageParams = {
      parent: params.parent,
      turnIndex,
      seq: seqStart,
      kind: "assistant_tool_call",
      role: "assistant",
      content: JSON.stringify({
        text: step.text,
        toolCalls: step.toolCalls.map((c) => ({
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        })),
      }),
    };
    // Results batch: successful executes plus tool-error feedback (invalid
    // inputs / execute throws) — both were fed back to the model, so both
    // must replay for context fidelity.
    const errors = step.content.filter((p) => p.type === "tool-error");
    const results = [
      ...step.toolResults.map((r) => ({
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: r.output,
      })),
      ...errors.map((e) => ({
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        output: { toolError: String(e.error) },
      })),
    ];
    if (results.length === 0) return [callRow];
    const resultRow: AppendMessageParams = {
      parent: params.parent,
      turnIndex,
      seq: seqStart + 1,
      kind: "tool_result",
      role: "tool",
      content: JSON.stringify({ results }),
    };
    return [callRow, resultRow];
  }

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
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        params.onTextDelta(part.text, i);
      } else if (TOOL_EVENT_TYPES.has(part.type)) {
        params.onToolEvent?.(part, i);
      }
    }

    const [steps, usage] = await Promise.all([result.steps, result.totalUsage]);
    // Closing prose = the FINAL step's text ("" when the loop ended on a
    // tool-call step); the caller's validation gate decides acceptability.
    const finalText = steps[steps.length - 1]?.text ?? "";
    const gate = validateTurn(finalText);

    if (gate === null) {
      // Success: persist the loop trail + closing prose in one atomic batch.
      const stepRowsAll = steps.reduce<readonly AppendMessageParams[]>(
        (acc, step) => [...acc, ...stepRows(step, batch.length + acc.length)],
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

    // Validation failure: persist the exhaust as a JSON envelope (see TSDoc).
    const failedRow: AppendMessageParams = {
      parent: params.parent,
      turnIndex,
      seq: batch.length,
      kind: "failed_assistant_response",
      role: "assistant",
      content: JSON.stringify({
        text: finalText,
        steps: steps.map((step) => ({
          toolCalls: step.toolCalls.map((c) => ({
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            input: c.input,
          })),
          results: step.toolResults.map((r) => ({
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: r.output,
          })),
        })),
      }),
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
      content: directiveFn(gate, i + 1),
    };
    return attempt(i + 1, [...batch, failedRow, directiveRow]);
  }

  return attempt(0, [userRow]);
}
