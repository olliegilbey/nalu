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
        input: c.input,
      })),
    }),
  };
  // Results batch: successful executes plus tool-error feedback (invalid
  // inputs / execute throws) — both were fed back to the model, so both
  // must replay for context fidelity. Content order, as the loop sent them:
  // the SDK builds the next Step's tool message from `step.content`, where
  // results sit in arrival order, not call order. A tool error stores the
  // exact text the loop sent as `errorText`, so it replays as the same
  // `error-text` bytes (#147). Rows written before that hold
  // `output: {toolError}`, listed after the successes.
  // The text can quote tool input: it belongs in this row, never in a log.
  // Typed as the renderer's entry, so the writer and reader share one shape.
  const results = step.content.flatMap((p): RenderedToolResult[] => {
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
