import type { StepResult, TextStreamPart, ToolSet } from "ai";
import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
  type AppendMessageParams,
  type ContextParent,
} from "@/db/queries/contextMessages";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { streamToolChat } from "@/lib/llm/streamToolChat";
import { SCOPING } from "@/lib/config/tuning";
import type { SeedInputs } from "@/lib/types/context";
import type { LlmUsage } from "@/lib/types/llm";
import { assembleLlmMessages } from "./contextAssembly";

/**
 * One attempt's tool surface: a fresh tool set (bound to a fresh collector
 * on the caller's side) plus the post-loop validation gate that inspects
 * that collector + the closing prose. A FACTORY rather than a static tool
 * set because retries must not inherit a failed attempt's staged state.
 */
export interface ToolTurnAttempt {
  readonly tools: ToolSet;
  /**
   * Post-loop validation (e.g. "free-text answers were submitted but
   * recordComprehensionSignals was never called"). Return null to accept;
   * a ValidationGateFailure to trigger the standard retry flow.
   */
  readonly validateTurn: (finalText: string) => ValidationGateFailure | null;
}

/** Inputs to {@link executeToolTurnStream}. */
export interface ExecuteToolTurnStreamParams {
  readonly parent: ContextParent;
  readonly seed: SeedInputs;
  /** Full pre-rendered user envelope (persisted verbatim as user_message). */
  readonly userMessageContent: string;
  /** Build a fresh tool set + validation gate per attempt (0-based). */
  readonly makeAttempt: (attempt: number) => ToolTurnAttempt;
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
  readonly onToolEvent?: (part: TextStreamPart<ToolSet>, attempt: number) => void;
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
 * - The LLM call is a `streamText` tool loop (`streamToolChat`): prose is
 *   plain streamed text (no partial-JSON projection — deltas forward as-is),
 *   structured actions arrive as tool calls staged by the caller's executes.
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
export async function executeToolTurnStream(
  params: ExecuteToolTurnStreamParams,
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
  function stepRows(step: StepResult<ToolSet>, seqStart: number): readonly AppendMessageParams[] {
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
    const { tools, validateTurn } = params.makeAttempt(i);
    params.onAttemptStart(i);

    const handle = await streamToolChat(llmMessages, { tools });

    // Drain the stream: forward prose deltas and tool lifecycle events.
    // Tool-turn prose is plain text — no monotonic-prefix workaround needed.
    for await (const part of handle.fullStream) {
      if (part.type === "text-delta") {
        params.onTextDelta(part.text, i);
      } else if (TOOL_EVENT_TYPES.has(part.type)) {
        params.onToolEvent?.(part, i);
      }
    }

    const final = await handle.final();
    const gate = validateTurn(final.text);

    if (gate === null) {
      // Success: persist the loop trail + closing prose in one atomic batch.
      const stepRowsAll = final.steps.reduce<readonly AppendMessageParams[]>(
        (acc, step) => [...acc, ...stepRows(step, batch.length + acc.length)],
        [],
      );
      const successRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length + stepRowsAll.length,
        kind: "assistant_response",
        role: "assistant",
        content: final.text,
      };
      await appendMessages([...batch, ...stepRowsAll, successRow]);
      return { finalText: final.text, usage: final.usage };
    }

    // Validation failure: persist the exhaust as a JSON envelope (see TSDoc).
    const failedRow: AppendMessageParams = {
      parent: params.parent,
      turnIndex,
      seq: batch.length,
      kind: "failed_assistant_response",
      role: "assistant",
      content: JSON.stringify({
        text: final.text,
        steps: final.steps.map((step) => ({
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
