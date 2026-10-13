import { findBracesOutsideCode, opensJsonKey } from "./proseBraces";

/**
 * Index of the first `{` that starts a JSON leak in prose, or null. A `{`
 * leaks when it opens a line, or when a quoted key follows it after
 * optional whitespace (newlines included), so `quiz: {"correct": "B"}`
 * is caught mid-line (#156). A property of any prose channel: a
 * JSON-imitation attempt dumps the would-be tool input (including the
 * plaintext `correct` answer key) into the TEXT channel, which bypasses
 * every tool-chunk redaction (observed live, 2026-07-08).
 *
 * Exempt, so teaching examples pass: anything inside a ``` fence or a
 * `backtick` span (`findBracesOutsideCode`). A `{` with no quote after it
 * passes too: set notation `{a, b}`, a Rust block brace. A line-start `{`
 * counts with or without a quote.
 *
 * Known gaps, where a dump streams live: a fenced or backticked dump (exempt
 * by design), and spans the backtick scanner misreads, such as
 * double-backtick spans and spans that cross a line. The post-loop gate
 * (`waveMidTurnGate.ts`) is their backstop. Its secret check is fence-blind
 * and fails any attempt whose prose uses the questionnaire tool's own field
 * names (`freetextRubric`, or `correct` with `conceptName`). Such a dump
 * never persists. A dump under invented field names can still persist.
 * #159 tracks the live glimpse.
 *
 * Accepted false positive: inline JSON written without backticks, such as
 * `you write { "key": "value" }` in a Wave that teaches JSON. The cut costs
 * little in either caller (below).
 *
 * Two callers cut prose here:
 * - `streamWaveTurn` stops forwarding text deltas to the client from this
 *   index for the rest of the attempt. Unlike the post-loop gate, it runs
 *   per delta and needs no parse: a false positive only truncates the
 *   TRANSIENT stream. The gate passes such prose (no envelope or secret
 *   key), `persistWaveMidTurn` writes it whole to chat_log, and
 *   `useWaveState` swaps the streamed bubble for chat_log on finish.
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
  const leak = findBracesOutsideCode(prose).find(
    (brace) => brace.opensLine || opensJsonKey(prose, brace.index),
  );
  return leak?.index ?? null;
}
