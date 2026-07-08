import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
  type AppendMessageParams,
  type ContextParent,
} from "@/db/queries/contextMessages";
import { NoObjectGeneratedError } from "ai";
import { generateChat } from "@/lib/llm/generate";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
import { JSON_PARSE_RETRY_DIRECTIVE } from "@/lib/prompts/turn";
import { SCOPING } from "@/lib/config/tuning";
import type { LlmUsage } from "@/lib/types/llm";
import type { SeedInputs } from "@/lib/types/context";
import type { z } from "zod/v4";
import { assembleLlmMessages } from "./contextAssembly";
import {
  formatHeader,
  formatParseFailure,
  formatParseSuccess,
  formatPromptBlock,
  formatResponseBlock,
  isLive,
  isQuiet,
} from "./formatTurn";
import { diagnoseFailure } from "./diagnoseFailure";

/**
 * Parameters for one invocation of `executeTurn`.
 *
 * The harness does JSON-parse + Zod-validate using `responseSchema`.
 * Refine `.message` strings from failed Zod parses become the retry
 * directive verbatim, so schema refine messages must be model-readable.
 *
 * `retryDirective` defaults to `(err) => err.detail` — the detail string
 * is the Zod issue list from `toValidationGateFailure`. Override only if
 * the caller needs different wording per attempt index.
 */
export interface ExecuteTurnParams<T> {
  readonly parent: ContextParent;
  readonly seed: SeedInputs;
  readonly userMessageContent: string;
  /**
   * Zod schema describing the strict JSON shape the model must return.
   * Used twice per turn: (1) at decode time via `generateChat` →
   * `toCerebrasJsonSchema` → Cerebras `response_format: { type: "json_schema",
   * strict: true }`, so invalid JSON is unreachable for the decoder;
   * (2) post-decode by the SDK's `Output.object` validate hook, which runs
   * this schema's `safeParse` (refines included), enforcing business
   * invariants (`.refine`/`.superRefine` rules that Cerebras strict mode
   * can't express, e.g. tier-scope, count bounds).
   * Refine `.message` text appears inside Zod's full issue-list JSON, which
   * becomes the retry directive — the model sees field paths, codes, and the
   * verbatim refine message together.
   */
  readonly responseSchema: z.ZodType<T>;
  /** Optional `name` field on the wire JSON schema (defaults to `seed.kind`). */
  readonly responseSchemaName?: string;
  readonly retryDirective?: (err: ValidationGateFailure, attempt: number) => string;
  /**
   * Optional human label for live-smoke observability (`CEREBRAS_LIVE=1`).
   * Names the per-turn stage in the banner — e.g. "clarify", "framework",
   * "baseline". Unused in production; falls back to `seed.kind`.
   */
  readonly label?: string;
  /**
   * Optional one-line projection of `parsed` used in the green ✓ summary
   * (e.g. `(p) => `questions=${p.questions.length}``). Falls back to a
   * generic shape hint if absent.
   */
  readonly successSummary?: (parsed: T) => string;
}

/** Result of a successful turn: parsed value + token usage from the winning LLM call. */
export interface ExecuteTurnResult<T> {
  readonly parsed: T;
  readonly usage: LlmUsage;
}

/**
 * Stage-agnostic per-turn lifecycle (spec §3.3).
 *
 * One call = one atomic write batch:
 *   1. Load prior rows for this parent (Wave or scoping pass).
 *   2. Render context (prior rows + the in-memory batch we're building this
 *      turn) → LLM messages.
 *   3. Call `generateChat` — the SDK's `Output.object` JSON-parses and
 *      Zod-validates the response before returning.
 *   4. On success: append `[user_message, ..., assistant_response]`
 *      as one batch via `appendMessages` and return.
 *   5. On `NoObjectGeneratedError`: convert to `ValidationGateFailure`
 *      (directive re-derived from the raw text), append a
 *      `failed_assistant_response` + `harness_retry_directive` to the
 *      in-memory batch and re-attempt up to `SCOPING.maxParseRetries`
 *      more times.
 *   6. Terminal exhaust: persist `[user, failed, directive, ..., failed]`
 *      (drop trailing directive — the caller's next turn IS the recovery
 *      context) and throw the `ValidationGateFailure`.
 *   7. Transport errors: propagate untouched. Nothing persisted.
 *
 * Atomicity boundary: a turn only commits rows to the DB when the batch
 * is finalised (success or terminal exhaust). Partial state never leaks.
 */
export async function executeTurn<T>(params: ExecuteTurnParams<T>): Promise<ExecuteTurnResult<T>> {
  // Reserve a turn_index up front — all rows persisted by this call share it.
  const turnIndex = await getNextTurnIndex(params.parent);
  // Prior rows are needed for context rendering; the polymorphic parent dictates the read query.
  const priorRows =
    params.parent.kind === "wave"
      ? await getMessagesForWave(params.parent.id)
      : await getMessagesForScopingPass(params.parent.id);

  // The user's message is always the first row of the batch (seq 0).
  const userRow: AppendMessageParams = {
    parent: params.parent,
    turnIndex,
    seq: 0,
    kind: "user_message",
    role: "user",
    content: params.userMessageContent,
  };
  // maxParseRetries=2 → up to 3 LLM attempts per turn under MVP config.
  // Sourced from SCOPING for now: scoping is the only stage live today, and
  // teaching has no reason to want a different budget at MVP. When teaching
  // lands we'll either share this value or promote it to a stage-neutral
  // namespace (e.g. `TURN`) — not worth the rename ripple before there's a
  // second caller.
  const totalAttempts = SCOPING.maxParseRetries + 1;
  // Default directive surfaces Zod's error.message verbatim (the harness
  // authors it inside toValidationGateFailure; .retryDirective lets callers
  // override).
  const directiveFn = params.retryDirective ?? ((err) => err.detail);

  // Live-smoke observability (CEREBRAS_LIVE=1). All emit decisions
  // collapse to noop in production — `live` is the master gate.
  const live = isLive();
  const quiet = isQuiet();
  const label = params.label ?? params.seed.kind;
  const headerTopic = params.seed.kind === "scoping" ? params.seed.topic : params.seed.courseTopic;
  const modelName = process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);
  // Wire-side response_format schema string — only built and displayed in live
  // mode AND only when the model actually honours strict-mode (i.e. will receive
  // response_format). Weak models get the schema inline in the user envelope
  // instead; showing it here would misrepresent the wire payload.
  const liveSchemaJson =
    live && capabilities.honorsStrictMode
      ? toSchemaJsonString(params.responseSchema, {
          name: params.responseSchemaName ?? params.seed.kind,
        })
      : undefined;

  /**
   * Recursive attempt loop — functional alternative to mutable loop state.
   * Threads the growing in-memory `batch` through each frame.
   * Bounded by `totalAttempts` (3 under MVP config) so stack depth is trivial.
   */
  async function attempt(
    i: number,
    batch: readonly AppendMessageParams[],
  ): Promise<ExecuteTurnResult<T>> {
    // Render context from prior DB rows + the in-memory batch (including any
    // failed/directive rows from earlier attempts *this turn*) so the model
    // sees its previous mistakes. Shared with executeTurnStream.
    const llmMessages = assembleLlmMessages(params.seed, priorRows, batch);
    // Banner per attempt — always emitted under live mode so a 3-retry turn
    // produces three banners and the reader knows which call's output follows.
    if (live) {
      process.stderr.write(
        formatHeader({
          label,
          attempt: i + 1,
          totalAttempts,
          model: modelName,
          topic: headerTopic,
        }),
      );
    }
    // Verbose mode: prompt printed inline before the call. Quiet mode:
    // suppressed on success, but we'll retroactively print it on failure.
    if (live && !quiet) {
      process.stderr.write(formatPromptBlock(llmMessages, liveSchemaJson));
    }

    const t0 = Date.now();
    try {
      // generateChat now JSON-parses AND Zod-validates via Output.object;
      // `parsed` is the typed result and `text` the raw string we persist.
      const result = await generateChat(llmMessages, {
        responseSchema: params.responseSchema,
        responseSchemaName: params.responseSchemaName ?? params.seed.kind,
      });
      const dt = Date.now() - t0;
      if (live && !quiet) {
        process.stderr.write(formatResponseBlock(result.text, dt, result.usage));
      }
      if (live) {
        const summary = params.successSummary
          ? params.successSummary(result.parsed)
          : `chars=${result.text.length}`;
        process.stderr.write(formatParseSuccess(label, summary));
      }
      const successRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length,
        kind: "assistant_response",
        role: "assistant",
        content: result.text,
      };
      await appendMessages([...batch, successRow]);
      return { parsed: result.parsed, usage: result.usage };
    } catch (err) {
      // Only the SDK's structured-output failure enters the retry flow;
      // transport-class errors propagate without persisting — the batch
      // never commits (same contract as before).
      if (!NoObjectGeneratedError.isInstance(err)) throw err;
      const dt = Date.now() - t0;
      const raw = err.text ?? "";
      const gate = toValidationGateFailure(raw, params.responseSchema);
      // Failure observability: flush the prompt + response trail (verbose
      // already printed the prompt; quiet retroactively flushes both).
      if (live) {
        if (quiet) {
          process.stderr.write(formatPromptBlock(llmMessages, liveSchemaJson));
        }
        process.stderr.write(formatResponseBlock(raw, dt, err.usage));
        const diagnosis = diagnoseFailure(gate, raw);
        process.stderr.write(formatParseFailure(label, gate, diagnosis));
      }
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
        // The caller's next user_message becomes the recovery context, so
        // appending a directive here would be redundant noise.
        await appendMessages([...batch, failedRow]);
        throw gate;
      }
      // Retry path: append failed row + directive and recurse with i+1.
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
 * Rebuild the legacy retry directive from a NoObjectGeneratedError's raw
 * text. Re-runs the same JSON.parse + safeParse the old in-harness gate
 * ran, so directive strings (and therefore persisted
 * `harness_retry_directive` rows and replayed prompts) are byte-identical
 * to the pre-Output implementation. The double-parse only happens on the
 * failure path — rare, and trivially cheap next to the LLM call.
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
  // re-parse can't see (e.g. secure-JSON prototype-pollution guard) —
  // treat as a JSON-shape failure rather than inventing a directive.
  return new ValidationGateFailure(
    "missing_response",
    safe.success ? JSON_PARSE_RETRY_DIRECTIVE : safe.error.message,
  );
}
