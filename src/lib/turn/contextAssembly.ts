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
  // demands array `ToolContent` rather than a plain string. The DB's
  // `context_messages.role` CHECK constraint allows 'tool', but no row kind
  // currently emits it — system/tool branches are unreachable in practice today.
  // Branching here keeps the type union narrow per arm so the call site compiles
  // without an unsafe cast over the whole array.
  return [
    { role: "system", content: rendered.system } satisfies LlmMessage,
    ...rendered.messages.map((m): LlmMessage => {
      // Narrow each role to the matching ModelMessage variant. 'tool' would
      // require ToolContent; if a future row kind emits role 'tool' we'll need
      // a separate code path (and a richer content shape).
      if (m.role === "assistant") return { role: "assistant", content: m.content };
      if (m.role === "system") return { role: "system", content: m.content };
      if (m.role === "tool") {
        throw new Error("assembleLlmMessages: tool-role rendered message is not supported");
      }
      return { role: "user", content: m.content };
    }),
  ];
}
