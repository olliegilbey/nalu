import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
  type AppendMessageParams,
  type ContextParent,
} from "@/db/queries/contextMessages";
import type { ContextMessage } from "@/db/schema";
import { generateChat } from "@/lib/llm/generate";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { renderContext } from "@/lib/llm/renderContext";
import { SCOPING } from "@/lib/config/tuning";
import type { LlmMessage, LlmUsage } from "@/lib/types/llm";
import type { SeedInputs } from "@/lib/types/context";
import type { z } from "zod/v4";
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
 * is the Zod issue list from `parseAndValidate`. Override only if the
 * caller needs different wording per attempt index.
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
   * (2) post-decode via `schema.safeParse(JSON.parse(text))`, which
   * enforces business invariants (`.refine`/`.superRefine` rules that
   * Cerebras strict mode can't express, e.g. tier-scope, count bounds).
   * Refine `.message` text flows verbatim into the retry directive.
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
 *   3. Call `generateChat`.
 *   4. JSON-parse the raw text and Zod-validate via `parseAndValidate`.
 *   5. On parse success: append `[user_message, ..., assistant_response]`
 *      as one batch via `appendMessages` and return.
 *   6. On `ValidationGateFailure`: append a `failed_assistant_response`
 *      + `harness_retry_directive` to the in-memory batch and re-attempt
 *      up to `SCOPING.maxParseRetries` more times.
 *   7. Terminal exhaust: persist `[user, failed, directive, ..., failed]`
 *      (drop trailing directive — the caller's next turn IS the recovery
 *      context) and re-throw the `ValidationGateFailure`.
 *   8. Transport errors: propagate untouched. Nothing persisted.
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
  // Default directive surfaces the parser's authored detail verbatim.
  const directiveFn = params.retryDirective ?? ((err) => err.detail);

  // Live-smoke observability (CEREBRAS_LIVE=1). All emit decisions
  // collapse to noop in production — `live` is the master gate.
  const live = isLive();
  const quiet = isQuiet();
  const label = params.label ?? params.seed.kind;
  const headerTopic = params.seed.kind === "scoping" ? params.seed.topic : params.seed.courseTopic;
  const modelName = process.env.LLM_MODEL ?? "(default)";

  /**
   * Recursive attempt loop — functional alternative to mutable loop state.
   * Threads the growing in-memory `batch` through each frame.
   * Bounded by `totalAttempts` (3 under MVP config) so stack depth is trivial.
   */
  async function attempt(
    i: number,
    batch: readonly AppendMessageParams[],
  ): Promise<ExecuteTurnResult<T>> {
    // Synthesise a renderable row list from prior DB rows + the in-memory batch.
    // The in-memory batch (including any failed/directive rows from earlier attempts
    // *this turn*) is part of the context so the model sees its previous mistakes.
    const renderable = synthesiseRows(priorRows, batch);
    const rendered = renderContext(params.seed, renderable);
    // Flatten system prompt + rendered messages into the SDK's flat message list.
    // `LlmMessage` (= `ModelMessage`) is a discriminated union where 'tool' role
    // demands array `ToolContent` rather than a plain string. The DB's
    // `context_messages.role` CHECK constraint allows 'tool', but no row kind
    // currently emits it — system/tool branches are unreachable in practice today.
    // Branching here keeps the type union narrow per arm so the call site compiles
    // without an unsafe cast over the whole array.
    const llmMessages: readonly LlmMessage[] = [
      { role: "system", content: rendered.system } satisfies LlmMessage,
      ...rendered.messages.map((m): LlmMessage => {
        // Narrow each role to the matching ModelMessage variant. 'tool' would
        // require ToolContent; if a future row kind emits role 'tool' we'll need
        // a separate code path (and a richer content shape).
        if (m.role === "assistant") return { role: "assistant", content: m.content };
        if (m.role === "system") return { role: "system", content: m.content };
        if (m.role === "tool") {
          throw new Error("executeTurn: tool-role rendered message is not supported");
        }
        return { role: "user", content: m.content };
      }),
    ];
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
      process.stderr.write(formatPromptBlock(llmMessages));
    }

    const t0 = Date.now();
    const result = await generateChat(llmMessages, {
      responseSchema: params.responseSchema,
      responseSchemaName: params.responseSchemaName ?? params.seed.kind,
    });
    const dt = Date.now() - t0;

    // Verbose mode: response printed inline. Quiet mode: suppressed for now;
    // the failure branch below replays it if needed.
    if (live && !quiet) {
      process.stderr.write(formatResponseBlock(result.text, dt, result.usage));
    }
    try {
      // JSON-parse + Zod-validate. Throws ValidationGateFailure on either failure.
      const parsed = parseAndValidate(result.text, params.responseSchema);
      if (live) {
        const summary = params.successSummary
          ? params.successSummary(parsed)
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
      return { parsed, usage: result.usage };
    } catch (err) {
      // Anything other than a validation gate failure is treated as a transport-class
      // error and propagates without persisting — the batch never commits.
      if (!(err instanceof ValidationGateFailure)) throw err;
      // Failure observability: in quiet mode we retroactively flush the
      // prompt + response so the reader has the full forensic trail.
      // In verbose mode they're already on stderr; just append diagnosis.
      if (live) {
        if (quiet) {
          process.stderr.write(formatPromptBlock(llmMessages));
          process.stderr.write(formatResponseBlock(result.text, dt, result.usage));
        }
        const diagnosis = diagnoseFailure(err, result.text);
        process.stderr.write(formatParseFailure(label, err, diagnosis));
      }
      const failedRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length,
        kind: "failed_assistant_response",
        role: "assistant",
        content: result.text,
      };
      if (i + 1 >= totalAttempts) {
        // Terminal exhaust: persist failure trail without trailing directive.
        // The caller's next user_message becomes the recovery context, so
        // appending a directive here would be redundant noise.
        await appendMessages([...batch, failedRow]);
        throw err;
      }
      // Retry path: append failed row + directive and recurse with i+1.
      const directiveRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length + 1,
        kind: "harness_retry_directive",
        role: "user",
        content: directiveFn(err, i + 1),
      };
      return attempt(i + 1, [...batch, failedRow, directiveRow]);
    }
  }

  return attempt(0, [userRow]);
}

/**
 * JSON-parse the model output then Zod-validate it against `schema`.
 * Throws `ValidationGateFailure` with a model-readable directive on either
 * failure mode. Generic directive on JSON shape failures (rare under
 * strict-mode constrained decoding but possible if the provider returns
 * text outside the JSON envelope); refine `.message` verbatim on
 * business-invariant failures.
 */
function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): T {
  // JSON.parse failure is wrapped so callers see a uniform ValidationGateFailure.
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ValidationGateFailure(
        "missing_response",
        "Your previous response did not parse as JSON. Reply with a single JSON object matching the schema attached to this turn.",
      );
    }
  })();
  const safe = schema.safeParse(parsed);
  if (!safe.success) {
    // Surface Zod's full issue list — refine `.message` strings include
    // field paths and the violated rule. The model needs the specifics.
    throw new ValidationGateFailure("missing_response", safe.error.message);
  }
  return safe.data;
}

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
function synthesiseRows(
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
