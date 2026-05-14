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
/**
 * Wrap with two SGR codes (e.g. dim + cyan). Keeps each segment readable
 * by emitting both codes in one prefix and a single reset on the suffix.
 */
function wrap2(c1: number, c2: number, s: string): string {
  return colorEnabled() ? `\x1b[${c1};${c2}m${s}\x1b[0m` : s;
}
const dim = (s: string): string => wrap(2, s);
const bold = (s: string): string => wrap(1, s);
const red = (s: string): string => wrap(31, s);
const green = (s: string): string => wrap(32, s);
const yellow = (s: string): string => wrap(33, s);
const cyan = (s: string): string => wrap(36, s);
// Bold variants used to differentiate role separators without colliding
// with the success/failure palette (✓ green, ✗ red).
const boldMagenta = (s: string): string => wrap2(1, 35, s);
const boldBlue = (s: string): string => wrap2(1, 34, s);
const boldYellow = (s: string): string => wrap2(1, 33, s);
// Dim+cyan for the inlined `response_format` block so it visually
// separates from message bodies while staying readable.
const dimCyan = (s: string): string => wrap2(2, 36, s);

/**
 * Per-role separator color. Chosen so each role has a distinct hue on
 * both dark and light backgrounds and so the assistant separator does
 * NOT reuse `green` (which is the success ✓ color) or `red` (failure).
 */
function colorForRole(role: string): (s: string) => string {
  if (role === "system") return boldMagenta;
  if (role === "user") return boldBlue;
  if (role === "assistant") return boldYellow;
  // Fallback — keeps `tool` / future roles visible but not styled.
  return dim;
}

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
 *
 * When `schema` is supplied, appends a clearly-labelled
 * `▼ response_format` block AFTER the messages so the reader can see the
 * full wire payload the provider receives. The schema string is NOT a
 * message — the header annotation calls this out explicitly so future
 * readers don't mistake it for one.
 *
 * The header line also annotates that `─── role ───` separators are
 * stderr-only formatting; they do not appear in the actual wire payload.
 */
export function formatPromptBlock(messages: readonly LlmMessage[], schema?: string): string {
  // Header doubles as a legend for the `─── role ───` lines below.
  const header = dim(
    `▼ messages sent to model (${messages.length}) — \`─── role ───\` lines are stderr-only, not in the wire payload`,
  );
  const blocks = messages.map((m) => {
    // Role-specific color on the separator so the eye can scan quickly.
    const colorise = colorForRole(m.role);
    const sep = colorise(`─── ${m.role} ───`);
    return `${sep}\n${stringifyMessageContent(m)}`;
  });
  // Optional schema block: surfaces what `generateChat` actually puts
  // into `response_format.json_schema.schema`. Use dim+cyan to keep it
  // visually distinct from the message bodies above.
  const schemaPart =
    schema !== undefined
      ? `\n${dimCyan("▼ response_format (sent as `response_format.json_schema.schema`, not as a message)")}\n${schema}\n`
      : "";
  return `\n${header}\n${blocks.join("\n")}\n${schemaPart}`;
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
  // The directive may include a `<response_schema>` block (when callers
  // pass a `buildRetryDirective` factory). Dim those lines so the
  // imperative prose stands out against the schema body.
  const indented = colorizeDirectiveLines(err.detail);
  const directive = `  ${dim("└─")} ${bold("retry directive (sent to model verbatim next attempt):")}\n${indented}`;
  return `${head}\n${diag}\n${directive}\n`;
}

/**
 * Indent + dim-highlight the schema portion of a retry directive.
 *
 * The directive format is:
 *   <imperative prose>
 *   <response_schema>
 *   …JSON…
 *   </response_schema>
 *
 * We dim everything from the opening tag through the closing tag so the
 * actionable prose stays bright while the bulky schema body recedes.
 * If no `<response_schema>` block is present (e.g. caller didn't pass a
 * factory), every line is left uncoloured.
 */
function colorizeDirectiveLines(detail: string): string {
  const lines = detail.split("\n");
  // Track whether we're inside the schema block to choose a per-line style.
  // `reduce` keeps the function `let`-free under `functional/no-let`.
  return lines
    .reduce<{ readonly out: readonly string[]; readonly inSchema: boolean }>(
      (acc, line) => {
        // Opening tag enters the block (and is itself dimmed).
        if (line.includes("<response_schema>")) {
          return { out: [...acc.out, `       ${dim(line)}`], inSchema: true };
        }
        // Closing tag exits (still part of the block visually).
        if (line.includes("</response_schema>")) {
          return { out: [...acc.out, `       ${dim(line)}`], inSchema: false };
        }
        const styled = acc.inSchema ? dim(line) : line;
        return { out: [...acc.out, `       ${styled}`], inSchema: acc.inSchema };
      },
      { out: [], inSchema: false },
    )
    .out.join("\n");
}
