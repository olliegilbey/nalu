import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
  type AppendMessageParams,
} from "@/db/queries/contextMessages";
import { NoObjectGeneratedError } from "ai";
import type { DeepPartial } from "ai";
import { streamChat } from "@/lib/llm/streamChat";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import { JSON_PARSE_RETRY_DIRECTIVE } from "@/lib/prompts/turn";
import { SCOPING } from "@/lib/config/tuning";
import type { z } from "zod/v4";
import { assembleLlmMessages } from "./contextAssembly";
import type { ExecuteTurnParams, ExecuteTurnResult } from "./executeTurn";

/**
 * Streaming extension of {@link ExecuteTurnParams}. The three hooks are how
 * the transport (UIMessage stream writer) observes the turn without this
 * module knowing anything about HTTP or the UI protocol.
 */
export interface ExecuteTurnStreamParams<T> extends ExecuteTurnParams<T> {
  /**
   * Project the learner-visible prose out of a (display-only, unvalidated)
   * partial. Return undefined while the field hasn't appeared yet.
   * Wave mid-turns: `(p) => p.userMessage`.
   */
  readonly progressText: (partial: DeepPartial<T>) => string | undefined;
  /** Called with each NEW chunk of prose (suffix-only; monotonic). */
  readonly onTextDelta: (delta: string, attempt: number) => void;
  /** Called before each attempt's stream starts (attempt is 0-based). The transport emits its reset signal for attempts > 0. */
  readonly onAttemptStart: (attempt: number) => void;
}

/**
 * Streaming sibling of `executeTurn` (read that file's contract first —
 * persisted rows, retry budget, atomicity are IDENTICAL; this adds only
 * progressive prose delivery). On a mid-stream validation failure the
 * failed attempt's text was already shown to the learner; the transport
 * layer handles the visual reset via `onAttemptStart`.
 */
export async function executeTurnStream<T>(
  params: ExecuteTurnStreamParams<T>,
): Promise<ExecuteTurnResult<T>> {
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

  async function attempt(
    i: number,
    batch: readonly AppendMessageParams[],
  ): Promise<ExecuteTurnResult<T>> {
    const llmMessages = assembleLlmMessages(params.seed, priorRows, batch);
    params.onAttemptStart(i);

    const handle = await streamChat(llmMessages, {
      responseSchema: params.responseSchema,
      responseSchemaName: params.responseSchemaName ?? params.seed.kind,
    });

    // Monotonic-prefix delta emission: only forward growth that extends
    // what we've already shown. Non-prefix rewrites (rare partial-JSON
    // repair artifacts) are skipped; the committed turn text self-heals
    // from server state after the stream finishes.
    const emitted = { text: "" };
    for await (const partial of handle.partialOutputStream) {
      const text = params.progressText(partial);
      if (
        text !== undefined &&
        text.length > emitted.text.length &&
        text.startsWith(emitted.text)
      ) {
        params.onTextDelta(text.slice(emitted.text.length), i);
        emitted.text = text;
      }
    }

    try {
      const final = await handle.final();
      const successRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length,
        kind: "assistant_response",
        role: "assistant",
        content: final.text,
      };
      await appendMessages([...batch, successRow]);
      return { parsed: final.parsed, usage: final.usage };
    } catch (err) {
      // Only the SDK's structured-output failure enters the retry flow;
      // transport-class errors propagate without persisting — the batch
      // never commits (same contract as executeTurn).
      if (!NoObjectGeneratedError.isInstance(err)) throw err;
      const raw = err.text ?? "";
      const gate = toValidationGateFailure(raw, params.responseSchema);
      const failedRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length,
        kind: "failed_assistant_response",
        role: "assistant",
        content: raw,
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
  }

  return attempt(0, [userRow]);
}

/**
 * Same directive re-derivation as executeTurn's helper — keep the two in
 * sync (or move to a shared module if a third caller appears; two callers
 * doesn't justify the abstraction yet per the no-premature-abstraction rule).
 */
function toValidationGateFailure<T>(raw: string, schema: z.ZodType<T>): ValidationGateFailure {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (parsed === undefined) {
    return new ValidationGateFailure("missing_response", JSON_PARSE_RETRY_DIRECTIVE);
  }
  const safe = schema.safeParse(parsed);
  // safeParse succeeding here means the SDK rejected for a reason our
  // re-parse can't see — treat as a JSON-shape failure rather than
  // inventing a directive (mirrors executeTurn).
  return new ValidationGateFailure(
    "missing_response",
    safe.success ? JSON_PARSE_RETRY_DIRECTIVE : safe.error.message,
  );
}
