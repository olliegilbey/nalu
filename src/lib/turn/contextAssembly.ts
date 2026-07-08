import type { ContextMessage } from "@/db/schema";
import type { AppendMessageParams } from "@/db/queries/contextMessages";
import { renderContext } from "@/lib/llm/renderContext";
import type { SeedInputs } from "@/lib/types/context";
import type { LlmMessage } from "@/lib/types/llm";

/**
 * Build a renderable row list from prior DB rows + the in-memory batch.
 *
 * `renderContext` only reads `turnIndex`, `seq`, `kind`, `role`, `content`
 * from each row — other `ContextMessage` fields are filled with inert
 * placeholders. These synthetic rows are never persisted; they exist only
 * for the duration of one `renderContext` call within an attempt.
 *
 * Including the in-memory batch is deliberate: during a retry the model
 * needs to see the failed attempt and the directive it produced. The
 * per-turn bucketing filter in `renderContext` drops those rows once the
 * turn ends in `assistant_response`, preserving cache-prefix stability
 * for successful turns.
 */
export function synthesiseRows(
  prior: readonly ContextMessage[],
  batch: readonly AppendMessageParams[],
): readonly ContextMessage[] {
  const batchAsRows: readonly ContextMessage[] = batch.map((b, i) => ({
    // Synthetic id — never read by renderContext; any non-empty string suffices.
    id: `synthetic-${i}`,
    // XOR FK fields mirror the persistence layer's discriminated-union mapping.
    waveId: b.parent.kind === "wave" ? b.parent.id : null,
    scopingPassId: b.parent.kind === "scoping" ? b.parent.id : null,
    turnIndex: b.turnIndex,
    seq: b.seq,
    kind: b.kind,
    role: b.role,
    content: b.content,
    // Inert timestamp — renderContext doesn't read createdAt.
    createdAt: new Date(0),
  }));
  return [...prior, ...batchAsRows];
}

/**
 * Render prior rows + the in-memory batch into the flat LLM message list
 * (system first). Shared by executeTurn and executeTurnStream so the
 * blocking and streaming paths can never drift on context assembly.
 */
export function assembleLlmMessages(
  seed: SeedInputs,
  prior: readonly ContextMessage[],
  batch: readonly AppendMessageParams[],
): readonly LlmMessage[] {
  const rendered = renderContext(seed, synthesiseRows(prior, batch));
  // Flatten system prompt + rendered messages into the SDK's flat message list.
  // `LlmMessage` (= `ModelMessage`) is a discriminated union where 'tool' role
  // demands array `ToolContent` rather than a plain string. Structured
  // variants (tool-call / tool-result, from the persisted tool rows) map to
  // the SDK's typed content parts; part property names (`input`/`output`,
  // `output: {type:'json', value}`) verified against installed ai@6.0.158
  // (`ToolCallPart`/`ToolResultPart` in @ai-sdk/provider-utils).
  return [
    { role: "system", content: rendered.system } satisfies LlmMessage,
    ...rendered.messages.map((m): LlmMessage => {
      // Structured tool-result message → tool role with ToolContent array.
      if (m.role === "tool") {
        if (!("results" in m)) {
          // Plain-content tool rows don't exist (only tool_result emits the
          // role); a string here means a row kind was mis-persisted.
          throw new Error("assembleLlmMessages: plain-content tool-role message is not supported");
        }
        return {
          role: "tool",
          content: m.results.map((r) => ({
            type: "tool-result" as const,
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: { type: "json" as const, value: r.output as never },
          })),
        };
      }
      // Structured assistant step with tool calls → text part (when
      // non-empty) followed by typed tool-call parts.
      if (m.role === "assistant" && "kind" in m && m.kind === "tool-call") {
        return {
          role: "assistant",
          content: [
            ...(m.text.length > 0 ? [{ type: "text" as const, text: m.text }] : []),
            ...m.toolCalls.map((c) => ({
              type: "tool-call" as const,
              toolCallId: c.toolCallId,
              toolName: c.toolName,
              input: c.input,
            })),
          ],
        };
      }
      // Only plain-content variants remain; the guard also narrows the type
      // (the structured assistant variant carries no `content`).
      if (!("content" in m)) {
        throw new Error("assembleLlmMessages: unhandled structured message variant");
      }
      if (m.role === "assistant") return { role: "assistant", content: m.content };
      if (m.role === "system") return { role: "system", content: m.content };
      return { role: "user", content: m.content };
    }),
  ];
}
