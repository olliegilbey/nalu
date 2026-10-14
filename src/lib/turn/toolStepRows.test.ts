import { describe, it, expect } from "vitest";
import { toolStepRows } from "./toolStepRows";
import { UnpairedToolCallError } from "./unpairedToolCallError";

const AT = {
  parent: { kind: "wave", id: "00000000-0000-0000-0000-000000000801" },
  turnIndex: 3,
  seqStart: 1,
} as const;

/** A Step fixture: only the fields `toolStepRows` reads. */
const stepOf = (step: {
  text?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  content?: unknown[];
}) =>
  ({
    text: step.text ?? "",
    toolCalls: step.toolCalls ?? [],
    toolResults: step.toolResults ?? [],
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

  it("throws UnpairedToolCallError naming each call with no result or tool-error", () => {
    const step = stepOf({
      toolCalls: [
        { toolCallId: "c1", toolName: "presentQuestionnaire", input: {} },
        { toolCallId: "c2", toolName: "getDueConcepts", input: {} },
      ],
      toolResults: [{ toolCallId: "c1", toolName: "presentQuestionnaire", output: {} }],
    });
    expect(() => toolStepRows(step, AT)).toThrow(UnpairedToolCallError);
    expect(() => toolStepRows(step, AT)).toThrow(/c2/);
  });
});
