/**
 * Pure formatters for live-smoke observability (`CEREBRAS_LIVE=1`).
 *
 * Rust-compiler-grade output: box-drawn headers, ANSI color on the
 * *meta* (status, diagnosis, retry directive), and the raw prompt /
 * response left uncolored so the model's bytes are what you read.
 *
 * Everything here is pure — no I/O. `executeTurn` decides when to emit
 * the returned strings to stderr. Tests can call these directly and
 * assert on substrings.
 */

import type { LlmMessage, LlmUsage } from "@/lib/types/llm";
import type { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

/** True when running under `just smoke` (or any `CEREBRAS_LIVE=1` invocation). */
export function isLive(): boolean {
  return process.env.CEREBRAS_LIVE === "1";
}

/**
 * Quiet mode: suppress per-turn prompt/response on success — header and
 * one-line ✓ summary only. Failures still print the full trail (prompt
 * + response + diagnosis) because that's the point of running a smoke.
 */
export function isQuiet(): boolean {
  return process.env.NALU_SMOKE_QUIET === "1";
}

// ---------------------------------------------------------------------------
// ANSI / TTY
// ---------------------------------------------------------------------------

/**
 * Color is on only when stderr is a TTY AND `NO_COLOR` is unset.
 * `NO_COLOR` follows the de-facto standard at https://no-color.org/.
 */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  return Boolean(process.stderr.isTTY);
}

function wrap(code: number, s: string): string {
  return colorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const dim = (s: string): string => wrap(2, s);
const bold = (s: string): string => wrap(1, s);
const red = (s: string): string => wrap(31, s);
const green = (s: string): string => wrap(32, s);
const yellow = (s: string): string => wrap(33, s);
const cyan = (s: string): string => wrap(36, s);

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface HeaderContext {
  readonly label: string;
  readonly attempt: number;
  readonly totalAttempts: number;
  readonly model: string;
  readonly topic: string;
}

/**
 * Banner emitted once per LLM attempt (so a 3-retry turn produces three
 * banners). 80-col bar so it's eye-grabbable even in a noisy log stream.
 */
export function formatHeader(ctx: HeaderContext): string {
  const bar = "━".repeat(80);
  const line =
    `${bold("turn")} ${cyan(ctx.label)}    ` +
    `${bold("attempt")} ${ctx.attempt}/${ctx.totalAttempts}    ` +
    `${bold("model")} ${ctx.model}    ` +
    `${bold("topic")} ${JSON.stringify(ctx.topic)}`;
  return `\n${bar}\n${line}\n${bar}\n`;
}

// ---------------------------------------------------------------------------
// Prompt block
// ---------------------------------------------------------------------------

/**
 * Renders the flattened LLM message list with `─── role ───` separators.
 * Body is raw text — never colored — so what you see is byte-identical
 * to what was sent (modulo the separator lines themselves).
 */
export function formatPromptBlock(messages: readonly LlmMessage[]): string {
  const header = dim(
    `▼ prompt sent (${messages.length} message${messages.length === 1 ? "" : "s"})`,
  );
  const blocks = messages.map((m) => {
    const sep = dim(`─── ${m.role} ───`);
    return `${sep}\n${stringifyMessageContent(m)}`;
  });
  return `\n${header}\n${blocks.join("\n")}\n`;
}

/**
 * `ModelMessage.content` is `string | Array<ContentPart>`. For the rows
 * `executeTurn` produces it's always a string — but type-narrow safely
 * for future-proofing rather than asserting.
 */
function stringifyMessageContent(m: LlmMessage): string {
  if (typeof m.content === "string") return m.content;
  // Multi-part content: render each part's `text` field (only kind we use).
  return m.content
    .map((p) => ("text" in p && typeof p.text === "string" ? p.text : JSON.stringify(p)))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Response block
// ---------------------------------------------------------------------------

/**
 * The raw assistant text plus a timing / token-usage subheader. Same
 * rule as the prompt: body is uncolored so the bytes are trustworthy.
 */
export function formatResponseBlock(text: string, durationMs: number, usage: LlmUsage): string {
  const subhead = formatUsage(durationMs, usage);
  const header = dim(`▼ response received  ${subhead}`);
  return `\n${header}\n${text}\n`;
}

function formatUsage(durationMs: number, usage: LlmUsage): string {
  const input = usage.inputTokens ?? "?";
  const output = usage.outputTokens ?? "?";
  return dim(`(${durationMs}ms · ${input} in / ${output} out)`);
}

// ---------------------------------------------------------------------------
// Parse outcomes
// ---------------------------------------------------------------------------

/**
 * One-line green ✓ summary for successful parses. `summary` is a tiny
 * caller-supplied projection (e.g. `"questions=3"` or `"tiers=4"`) so
 * the reader sees at a glance whether the shape is roughly right.
 */
export function formatParseSuccess(label: string, summary: string): string {
  return `${green("✓")} ${bold("parse OK")}  ${cyan(label)}  ${dim(summary)}\n`;
}

/**
 * Multi-block ✗ failure: gate reason, diagnosis heuristic, and the
 * retry directive the model will see next attempt (verbatim).
 * `diagnosis` is the output of `diagnoseFailure()`.
 */
export function formatParseFailure(
  label: string,
  err: ValidationGateFailure,
  diagnosis: string,
): string {
  const head = `${red("✗")} ${bold("parse FAILED")}  ${cyan(label)}  ${yellow(err.reason)}`;
  const diag = `  ${dim("└─")} ${bold("diagnosis:")} ${diagnosis}`;
  // Indent each line of the retry directive so multi-line ones stay aligned.
  const indented = err.detail
    .split("\n")
    .map((l) => `       ${l}`)
    .join("\n");
  const directive = `  ${dim("└─")} ${bold("retry directive (sent to model verbatim next attempt):")}\n${indented}`;
  return `${head}\n${diag}\n${directive}\n`;
}
