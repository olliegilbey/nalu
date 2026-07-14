import { awaitCerebrasCallSlot } from "./cerebrasRateLimit";
import type { LlmMessage } from "@/lib/types/llm";

/**
 * Shared tool-loop `prepareStep` — REQUIRED on every Cerebras tool-loop call
 * site (the `ToolLoopAgent` definitions in `src/lib/agents/`). Two jobs, both
 * per step:
 * 1. Gate through `awaitCerebrasCallSlot` — steps 2..N are additional
 *    provider calls a single pre-call gate would miss (prepareStep runs
 *    before EACH provider call, verified in installed ai@6.0.158).
 * 2. Strip assistant `reasoning` parts: gpt-oss-120b emits reasoning, the
 *    openai-compatible adapter round-trips it as `reasoning_content`, and
 *    Cerebras rejects that as an input property (400 wrong_api_format) —
 *    probe verdict finding 1 (docs/status/2026-07-06-tool-call-probe-verdict.md).
 *    Plain-string assistant messages pass through.
 */
// Param is structurally just `{ messages }` (a supertype of every concrete
// PrepareStepFunction<TOOLS> options object) so one helper serves all tool
// sets — TS can't infer a TOOLS generic across an assignment position.
export const cerebrasToolLoopPrepareStep = async ({
  messages: stepMessages,
}: {
  readonly messages: LlmMessage[];
}): Promise<{ readonly messages: LlmMessage[] }> => {
  await awaitCerebrasCallSlot();
  return {
    messages: stepMessages.map((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? { ...m, content: m.content.filter((p) => p.type !== "reasoning") }
        : m,
    ),
  };
};
