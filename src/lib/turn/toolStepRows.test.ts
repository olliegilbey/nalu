import { describe, it, expect } from "vitest";
import { toolStepRows } from "./toolStepRows";
import { UnpairedToolCallError } from "./unpairedToolCallError";

const AT = {
  parent: { kind: "wave", id: "00000000-0000-0000-0000-000000000801" },
  turnIndex: 3,
  seqStart: 1,
} as const;

/** A Step fixture: only the fields `toolStepRows` reads. Results live in `content`. */
const stepOf = (step: { text?: string; toolCalls?: unknown[]; content?: unknown[] }) =>
  ({
    text: step.text ?? "",
    toolCalls: step.toolCalls ?? [],
    content: step.content ?? [],
  }) as unknown as Parameters<typeof toolStepRows>[0];

describe("toolStepRows", () => {
  it("maps a pure-text Step to no rows", () => {
    expect(toolStepRows(stepOf({ text: "Just prose." }), AT)).toEqual([]);
  });

  it("persists tool-error feedback into the tool_result row (in-loop self-correction trail)", () => {
    const rows = toolStepRows(
      stepOf({
        toolCalls: [{ toolCallId: "bad", toolName: "presentQuestionnaire", input: { x: 1 } }],
        content: [
          {
            type: "tool-error",
            toolCallId: "bad",
            toolName: "presentQuestionnaire",
            // An Error, so String(error) would differ: "Error: Invalid input".
            error: new Error("Invalid input"),
          },
        ],
      }),
      AT,
    );
    expect(rows.map((r) => [r.kind, r.seq, r.turnIndex])).toEqual([
      ["assistant_tool_call", 1, 3],
      ["tool_result", 2, 3],
    ]);
    // The tool-error is the call's answer, so the pair is complete. Its
    // text is what the SDK sent in-loop: getErrorMessage, not String (#147).
    expect(JSON.parse(rows[1]?.content ?? "")).toEqual({
      results: [
        {
          toolCallId: "bad",
          toolName: "presentQuestionnaire",
          errorText: "Invalid input",
        },
      ],
    });
  });

  it("stores results in tool-call order, as the loop sends them, though the error arrived first", () => {
    const rows = toolStepRows(
      stepOf({
        toolCalls: [
          { toolCallId: "good", toolName: "getDueConcepts", input: {} },
          { toolCallId: "bad", toolName: "getDueConcepts", input: {} },
        ],
        content: [
          { type: "tool-error", toolCallId: "bad", toolName: "getDueConcepts", error: "x" },
          { type: "tool-result", toolCallId: "good", toolName: "getDueConcepts", output: {} },
        ],
      }),
      AT,
    );
    const { results } = JSON.parse(rows[1]?.content ?? "") as {
      results: { toolCallId: string }[];
    };
    expect(results.map((r) => r.toolCallId)).toEqual(["good", "bad"]);
  });

  it("sorts as the SDK does: a repeated call keeps its first rank, results sharing a call keep arrival order, an unmatched result goes last", () => {
    // Mirrors `sortToolResultContentByToolCallOrder` (ai@6.0.306). Ranking
    // by last appearance would put "a" after "b".
    const rows = toolStepRows(
      stepOf({
        toolCalls: [
          { toolCallId: "a", toolName: "getDueConcepts", input: {} },
          { toolCallId: "b", toolName: "getDueConcepts", input: {} },
          { toolCallId: "a", toolName: "getDueConcepts", input: {} },
        ],
        content: [
          { type: "tool-result", toolCallId: "x", toolName: "getDueConcepts", output: {} },
          { type: "tool-result", toolCallId: "b", toolName: "getDueConcepts", output: {} },
          { type: "tool-result", toolCallId: "a", toolName: "getDueConcepts", output: { n: 1 } },
          { type: "tool-result", toolCallId: "a", toolName: "getDueConcepts", output: { n: 2 } },
        ],
      }),
      AT,
    );
    const { results } = JSON.parse(rows[1]?.content ?? "") as {
      results: { toolCallId: string; output: unknown }[];
    };
    expect(results.map((r) => r.toolCallId)).toEqual(["a", "a", "b", "x"]);
    // The two results for "a" tie on rank, so they keep arrival order.
    expect(results.slice(0, 2).map((r) => r.output)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("throws UnpairedToolCallError naming each call with no result or tool-error", () => {
    const step = stepOf({
      toolCalls: [
        { toolCallId: "c1", toolName: "presentQuestionnaire", input: {} },
        { toolCallId: "c2", toolName: "getDueConcepts", input: {} },
      ],
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "presentQuestionnaire", output: {} },
      ],
    });
    expect(() => toolStepRows(step, AT)).toThrow(UnpairedToolCallError);
    expect(() => toolStepRows(step, AT)).toThrow(/c2/);
  });
});
