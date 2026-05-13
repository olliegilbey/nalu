/**
 * Heuristic post-mortem for `ValidationGateFailure`s during live smoke.
 *
 * Goal: one short string that points at the *probable root cause* of a
 * parse failure, so a reader scanning the smoke output can decide
 * "weak prompt vs noise" without re-reading the raw response.
 *
 * Strategy (cheap-to-expensive checks, first hit wins):
 *   1. **Tag presence.** If the parser's directive names a tag and the
 *      raw response contains a *different* known scoping tag, say so —
 *      this is the classic "model is in the wrong stage" failure.
 *   2. **Shape match.** If a known tag is present but the JSON inside
 *      shadows another stage's schema, surface that — e.g. a baseline
 *      payload that looks like a framework (`tiers` array present).
 *   3. **Fallback.** Echo the gate's `reason` field with a short hint.
 *
 * Heuristics are intentionally simple regex + keyword checks: they're
 * read by a human as *hypotheses*, not enforced as facts. No false
 * positives that mislead, no false negatives that hide signal.
 */

import type { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { extractTag } from "@/lib/llm/extractTag";

/** Tags the scoping flow emits — the universe of "known stages" for shape mismatch. */
const KNOWN_TAGS = ["questions", "framework", "baseline"] as const;
type KnownTag = (typeof KNOWN_TAGS)[number];

/** Keyword signatures inside a tag body that hint at *which* stage's payload it actually is. */
const SHAPE_SIGNATURES: Record<KnownTag, readonly string[]> = {
  // A clarify payload is a bare JSON array — no defining keys. Empty list = no
  // shape signature (we never assert "it looks like clarify"); covered by tag-name match only.
  questions: [],
  framework: ['"tiers"', '"estimatedStartingTier"', '"baselineScopeTiers"'],
  baseline: ['"questions"', '"id"', '"tier"', '"prompt"'],
};

/** Pull the expected tag name out of the parser's directive, if present. */
function expectedTagFromDirective(directive: string): KnownTag | null {
  for (const t of KNOWN_TAGS) {
    if (directive.includes(`<${t}>`)) return t;
  }
  return null;
}

/**
 * Score a candidate tag body for shape match — the count of signature
 * substrings it contains. Higher = stronger match.
 */
function scoreShape(body: string, tag: KnownTag): number {
  return SHAPE_SIGNATURES[tag].filter((sig) => body.includes(sig)).length;
}

export function diagnoseFailure(err: ValidationGateFailure, raw: string): string {
  const expected = expectedTagFromDirective(err.detail);

  // (1) Tag-name mismatch: parser wants <X>, model emitted <Y>.
  if (expected !== null) {
    const presentOther = KNOWN_TAGS.filter((t) => t !== expected && extractTag(raw, t) !== null);
    if (presentOther.length > 0) {
      return (
        `parser expected <${expected}> but the response contains ` +
        `<${presentOther.join(">, <")}> — model appears to be in the wrong stage.`
      );
    }
    // Tag missing entirely (no other known tag either).
    if (extractTag(raw, expected) === null) {
      return `parser expected <${expected}> but no such tag is present in the response.`;
    }

    // (2) Tag present — does its body match a *different* schema's signature?
    const body = extractTag(raw, expected) ?? "";
    const ownScore = scoreShape(body, expected);
    const otherScores = KNOWN_TAGS.filter((t) => t !== expected).map((t) => ({
      tag: t,
      score: scoreShape(body, t),
    }));
    const bestOther = otherScores.reduce((a, b) => (b.score > a.score ? b : a), {
      tag: expected,
      score: -1,
    });
    if (bestOther.score > 0 && bestOther.score > ownScore) {
      return (
        `<${expected}> tag is present but its body matches the <${bestOther.tag}> schema ` +
        `more closely than <${expected}> — the wrapper is right, the payload is from a different stage.`
      );
    }

    // (3) Tag present, shape unclear — fall through to JSON/zod hint.
    return interpretReason(err);
  }

  return interpretReason(err);
}

/**
 * Last-resort interpreter when no tag hint is recoverable from the
 * directive. Surfaces the gate's reason field with a brief gloss, plus
 * the first zod-issue line if one is embedded.
 */
function interpretReason(err: ValidationGateFailure): string {
  // Parsers embed zod's `error.message` JSON verbatim in the detail string.
  // If we can spot the leading '[' of a zod issue array, point the reader at it.
  const zodHint = err.detail.match(/\[\s*\{[\s\S]*?"path":\s*\[[^\]]*\]/);
  if (zodHint !== null) {
    return `zod schema validation failed — see retry directive below for the precise field path(s).`;
  }
  if (err.reason === "missing_final_turn_tags") {
    return `required final-turn tags (e.g. <next_lesson_blueprint>, <course_summary_update>) are missing.`;
  }
  return `gate '${err.reason}' tripped — see retry directive below.`;
}
