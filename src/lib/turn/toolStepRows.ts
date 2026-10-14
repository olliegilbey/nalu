import type { StepResult, ToolSet } from "ai";
import type { AppendMessageParams, ContextParent } from "@/db/queries/contextMessages";
import type { RenderedToolResult } from "@/lib/llm/renderContext";
import { toolErrorText } from "@/lib/llm/toolErrorText";
import { UnpairedToolCallError } from "./unpairedToolCallError";

/** Where a Step's rows land: the Turn's parent and index, and the first row's seq. */
export interface ToolStepRowsPosition {
  readonly parent: ContextParent;
  readonly turnIndex: number;
  readonly seqStart: number;
}

/**
 * Pure: map one tool-loop Step to its persisted `assistant_tool_call` +
 * `tool_result` row pair; empty for a pure-text Step. Throws
 * {@link UnpairedToolCallError} when a call has neither a result nor a
 * tool-error, so an orphan call is never written.
 */
export function toolStepRows<TOOLS extends ToolSet>(
  step: StepResult<TOOLS>,
  at: ToolStepRowsPosition,
): readonly AppendMessageParams[] {
  if (step.toolCalls.length === 0) return [];
  const callRow: AppendMessageParams = {
    parent: at.parent,
    turnIndex: at.turnIndex,
    seq: at.seqStart,
    kind: "assistant_tool_call",
    role: "assistant",
    content: JSON.stringify({
      text: step.text,
      toolCalls: step.toolCalls.map((c) => ({
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        // Unparseable arguments leave the raw string as an invalid call's
        // input. In-loop the SDK sends {} instead (`toResponseMessages`).
        // Store what it sent, so the next Turn replays the same bytes (#163).
        // The test is the SDK's own: a parsed object, or null, passes through.
        // Rows written before #163 keep their string.
        input: c.invalid === true && typeof c.input !== "object" ? {} : c.input,
      })),
    }),
  };
  // Results batch: successful executes plus tool-error feedback (invalid
  // inputs / execute throws) — both were fed back to the model, so both
  // must replay for context fidelity. `step.content` holds them in arrival
  // order; the loop sends them in tool-call order, so they are stored that
  // way (`sortByToolCallOrder`, below). A tool error stores the exact text
  // the loop sent as `errorText`, so it replays as the same `error-text`
  // bytes (#147). Rows written before that hold `output: {toolError}`,
  // listed after the successes.
  // The text can quote tool input: it belongs in this row, never in a log.
  // Typed as the renderer's entry, so the writer and reader share one shape.
  const arrived = step.content.flatMap((p): RenderedToolResult[] => {
    if (p.type === "tool-result") {
      return [{ toolCallId: p.toolCallId, toolName: p.toolName, output: p.output }];
    }
    if (p.type === "tool-error") {
      return [
        { toolCallId: p.toolCallId, toolName: p.toolName, errorText: toolErrorText(p.error) },
      ];
    }
    return [];
  });
  const results = sortByToolCallOrder(arrived, step.toolCalls);
  // Every call needs its answer: Cerebras rejects an unanswered tool call
  // on replay, which would break every later Turn of the Wave. Refuse to
  // write the orphan; end the attempt abnormally instead.
  const answered = new Set(results.map((r) => r.toolCallId));
  const unpaired = step.toolCalls.map((c) => c.toolCallId).filter((id) => !answered.has(id));
  if (unpaired.length > 0) throw new UnpairedToolCallError(unpaired);
  const resultRow: AppendMessageParams = {
    parent: at.parent,
    turnIndex: at.turnIndex,
    seq: at.seqStart + 1,
    kind: "tool_result",
    role: "tool",
    content: JSON.stringify({ results }),
  };
  return [callRow, resultRow];
}

/**
 * Put a Step's results in the order the loop sends them. Mirrors
 * `sortToolResultContentByToolCallOrder` in ai@6.0.306 (added in 6.0.220).
 * A call ranks by its first appearance among the Step's tool calls (the
 * SDK reads the same tool-call parts of `step.content`). Equal ranks keep
 * arrival order. A result with no matching call goes last. Rows written
 * before this sort keep the arrival order the older SDK sent.
 */
function sortByToolCallOrder(
  results: readonly RenderedToolResult[],
  toolCalls: readonly { readonly toolCallId: string }[],
): readonly RenderedToolResult[] {
  // Filled in a loop because a repeated id keeps its first rank, as in the SDK.
  const rank = new Map<string, number>();
  for (const { toolCallId } of toolCalls) {
    if (!rank.has(toolCallId)) rank.set(toolCallId, rank.size);
  }
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      const aRank = rank.get(a.result.toolCallId);
      const bRank = rank.get(b.result.toolCallId);
      if (aRank === undefined && bRank === undefined) return a.index - b.index;
      if (aRank === undefined) return 1;
      if (bRank === undefined) return -1;
      return aRank - bRank || a.index - b.index;
    })
    .map(({ result }) => result);
}
