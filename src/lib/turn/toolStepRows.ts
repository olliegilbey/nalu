import type { StepResult, ToolSet } from "ai";
import type { AppendMessageParams, ContextParent } from "@/db/queries/contextMessages";
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
