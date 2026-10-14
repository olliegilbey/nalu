/**
 * Index of the first `{` that opens a line (only whitespace before it)
 * OUTSIDE a ``` fence, or null. A property of any prose channel: a
 * JSON-imitation attempt dumps the would-be tool input (including the
 * plaintext `correct` answer key) into the TEXT channel, which bypasses
 * every tool-chunk redaction (observed live, 2026-07-08). Fence-aware, so
 * legit fenced JSON teaching examples pass.
 *
 * Two callers cut prose here:
 * - `streamWaveTurn` stops forwarding text deltas to the client from this
 *   index for the rest of the attempt. Unlike the post-loop gate
 *   (`waveMidTurnGate.ts`), it runs per delta and needs no parse-to-end
 *   certainty: a false positive only truncates the TRANSIENT stream (full
 *   prose still reaches chat_log after the turn-end refetch).
 * - `executeToolTurnStream` persists a failed attempt as its prose cut
 *   here, so a retry replays what the learner saw, never the JSON (#140).
 */
export function findJsonProseLeakIndex(prose: string): number | null {
  let inFence = false;
  let offset = 0;
  for (const line of prose.split("\n")) {
    const body = line.trimStart();
    if (body.startsWith("```")) {
      inFence = !inFence;
    } else if (!inFence && body.startsWith("{")) {
      return offset + (line.length - body.length);
    }
    offset += line.length + 1; // +1 for the split-away "\n"
  }
  return null;
}
