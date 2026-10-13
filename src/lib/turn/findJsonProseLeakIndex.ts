/**
 * Index of the first `{` that starts a JSON leak in prose, or null. A `{`
 * leaks when it opens a line, or when a quoted key follows it after
 * optional whitespace (newlines included), so `quiz: {"correct": "B"}`
 * is caught mid-line (#156). A property of any prose channel: a
 * JSON-imitation attempt dumps the would-be tool input (including the
 * plaintext `correct` answer key) into the TEXT channel, which bypasses
 * every tool-chunk redaction (observed live, 2026-07-08).
 *
 * Exempt, so teaching examples pass: anything inside a ``` fence, and
 * anything inside a `backtick` span. Span state resets at each line end.
 * A `{` with no quote after it passes too: set notation `{a, b}`, a Rust
 * block brace. A line-start `{` counts with or without a quote.
 *
 * Accepted false positive: inline JSON written without backticks, such as
 * `you write { "key": "value" }` in a Wave that teaches JSON. The cut costs
 * little in either caller (below).
 *
 * Two callers cut prose here:
 * - `streamWaveTurn` stops forwarding text deltas to the client from this
 *   index for the rest of the attempt. Unlike the post-loop gate
 *   (`waveMidTurnGate.ts`), it runs per delta and needs no parse-to-end
 *   certainty: a false positive only truncates the TRANSIENT stream. The
 *   gate passes such prose, `persistWaveMidTurn` writes it whole to
 *   chat_log, and `useWaveState` swaps the streamed bubble for chat_log on
 *   finish.
 * - `executeToolTurnStream` persists a failed attempt as its prose cut
 *   here, so a retry replays what the learner saw, never the JSON (#140).
 *   A false positive there only shortens a replay the retry discards.
 *
 * Streaming: every verdict depends only on the prose up to the `{`, except
 * the quoted-key check. A `{` followed only by whitespace so far has no
 * verdict yet, so it streams. If the next delta opens a key, this index
 * falls behind the forwarded text and `streamWaveTurn` forwards nothing
 * more. So at most the `{` and its trailing whitespace reach the client,
 * never a byte of the JSON body.
 */
export function findJsonProseLeakIndex(prose: string): number | null {
  let inFence = false;
  let offset = 0;
  for (const line of prose.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (line.startsWith("```", indent)) {
      inFence = !inFence;
    } else if (!inFence) {
      const leakAt = findLeakInLine(prose, offset, line, indent);
      if (leakAt !== null) return leakAt;
    }
    offset += line.length + 1; // +1 for the split-away "\n"
  }
  return null;
}

/**
 * Prose index of the first leaking `{` on one unfenced line, or null. The
 * line starts at `offset` in `prose`; `indent` counts its leading
 * whitespace. Backticks toggle an inline code span, like ``` toggles a fence.
 */
function findLeakInLine(
  prose: string,
  offset: number,
  line: string,
  indent: number,
): number | null {
  let inCode = false;
  for (let i = indent; i < line.length; i++) {
    if (line[i] === "`") {
      inCode = !inCode;
    } else if (line[i] === "{" && !inCode && (i === indent || opensJsonKey(prose, offset + i))) {
      return offset + i;
    }
  }
  return null;
}

/**
 * True when the next non-whitespace character after the `{` at `braceAt`
 * is `"`, the start of a JSON key. Looks past line ends, so a prose line
 * ending in `{` above a pretty-printed body still counts.
 */
function opensJsonKey(prose: string, braceAt: number): boolean {
  return prose
    .slice(braceAt + 1)
    .trimStart()
    .startsWith('"');
}
