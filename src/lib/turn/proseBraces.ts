/** A `{` in prose that sits outside every ``` fence and `backtick` span. */
export interface ProseBrace {
  /** Index of the `{` in the prose. */
  readonly index: number;
  /** True when only whitespace precedes the `{` on its line. */
  readonly opensLine: boolean;
}

/**
 * Every `{` in prose outside ``` fences and `backtick` spans, in order. Code
 * is where teaching examples live, so both JSON-leak checks skip it: the
 * stream guard (`findJsonProseLeakIndex`) and the post-loop gate's envelope
 * check (`waveMidTurnGate.ts`).
 *
 * A line that starts with ``` toggles a fence. Each backtick toggles an
 * inline code span, and span state resets at each line end. That is simpler
 * than CommonMark, so it misreads double-backtick spans and spans that cross
 * a line. In exchange it is prefix-stable: whether a `{` counts depends only
 * on the text before it, so a streaming caller's verdicts never move back.
 */
export function findBracesOutsideCode(prose: string): readonly ProseBrace[] {
  let inFence = false;
  let offset = 0;
  const braces: ProseBrace[] = []; // filled by the scan below
  for (const line of prose.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (line.startsWith("```", indent)) {
      inFence = !inFence;
    } else if (!inFence) {
      braces.push(...findBracesOutsideSpans(line, offset, indent));
    }
    offset += line.length + 1; // +1 for the split-away "\n"
  }
  return braces;
}

/**
 * The `{`s on one unfenced line that sit outside `backtick` spans. The line
 * starts at `offset` in the prose; `indent` counts its leading whitespace.
 */
function findBracesOutsideSpans(line: string, offset: number, indent: number): ProseBrace[] {
  let inCode = false;
  const braces: ProseBrace[] = [];
  for (let i = indent; i < line.length; i++) {
    if (line[i] === "`") {
      inCode = !inCode;
    } else if (line[i] === "{" && !inCode) {
      braces.push({ index: offset + i, opensLine: i === indent });
    }
  }
  return braces;
}

/**
 * True when the next non-whitespace character after the `{` at `braceAt`
 * is `"`, the start of a JSON key. Looks past line ends, so a prose line
 * ending in `{` above a pretty-printed body still counts.
 */
export function opensJsonKey(prose: string, braceAt: number): boolean {
  // Sticky: match exactly at lastIndex, so no per-brace copy of the prose.
  // The literal builds a fresh RegExp per call, so lastIndex is never shared.
  const keyAhead = /\s*"/y;
  keyAhead.lastIndex = braceAt + 1;
  return keyAhead.test(prose);
}
