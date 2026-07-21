/**
 * Gated, redaction-aware diagnostics for the free-text grading pipeline
 * (GitHub issue #22: correct free-text answers awarding 0 XP).
 *
 * Everything here is a pure formatter plus one env gate. NO I/O — callers own
 * the `process.stderr.write`, exactly like `src/lib/turn/formatTurn.ts`. Kept
 * dependency-free (only `process.env` + string ops) so the three call sites in
 * three different layers — `src/lib/prompts/closeTurn.ts` (strip path),
 * `src/lib/turn/executeTurn.ts` (parse-failure dump), and `src/lib/course/*`
 * (per-grading content log) — can all import it without an import cycle.
 *
 * Redaction constraint (issue #22 spec): learner answer excerpts must NEVER
 * reach prod logs. `isGradingDebugEnabled()` is the single gate every content
 * log MUST be wrapped in; flag-off is a true no-op. Excerpts are additionally
 * truncated here so even flag-on output caps how much learner text is emitted.
 */

/**
 * Master gate for all learner-content grading diagnostics. True only when
 * `LLM_DEBUG_GRADINGS=1`. Read directly from `process.env` (not `getEnv()`) —
 * mirrors the `LLM_TELEMETRY` / `LLM_DEVTOOLS` observability-flag convention in
 * `src/lib/config.ts`: keeps it out of the boot-time schema (a typo can't crash
 * the app) and unit-test-friendly (set the var per test). Off ⇒ true no-op.
 */
export function isGradingDebugEnabled(): boolean {
  return process.env.LLM_DEBUG_GRADINGS === "1";
}

/** Max chars of a learner free-text excerpt in a debug line — redaction cap. */
export const GRADING_DEBUG_EXCERPT_MAX = 80;

/**
 * Pure: truncate `s` to `max` chars, appending `…` when it was cut. Whitespace
 * runs are collapsed to a single space so one grading always occupies one log
 * line (learner answers may contain newlines).
 */
export function truncateForDebug(s: string, max: number): string {
  const flattened = s.replace(/\s+/g, " ").trim();
  if (flattened.length <= max) return flattened;
  return `${flattened.slice(0, max)}…`;
}

/** Fields for one `formatGradingDebugLine` row. Free-text-only fields are optional. */
export interface GradingDebugFields {
  /** Call-site context, e.g. `"wave-close"`, `"scoping-close"`, `"strip"`. */
  readonly context: string;
  /** Raw question id from the model's grading. */
  readonly questionId: string;
  /** `"free-text"`, `"mc-index"`, or `"unknown"` (pre-parse strip path). */
  readonly kind: string;
  /** Free-text verdict, when known. */
  readonly verdict?: string;
  /** Free-text quality score (0-5), when known. */
  readonly qualityScore?: number;
  /**
   * The XP this grading would award (`calculateXP(tier, qualityScore)`),
   * computed by the caller. This is the diagnostic payload for issue #22
   * hypothesis (2): q0/q1 → `xp≈0` even for a "correct" answer.
   */
  readonly computedXp?: number;
  /** Learner's raw free-text answer; truncated here to the redaction cap. */
  readonly answerExcerpt?: string;
}

/**
 * Pure: render one grading as a single `[grading-debug]` line. Only the fields
 * that are present are emitted, so an `mc-index` grading stays compact and a
 * free-text grading carries verdict/quality/xp/excerpt. The excerpt is
 * truncated to {@link GRADING_DEBUG_EXCERPT_MAX} regardless of flag state.
 */
export function formatGradingDebugLine(f: GradingDebugFields): string {
  const parts: string[] = [
    "[grading-debug]",
    f.context,
    `qid=${JSON.stringify(f.questionId)}`,
    `kind=${f.kind}`,
  ];
  if (f.verdict !== undefined) parts.push(`verdict=${f.verdict}`);
  if (f.qualityScore !== undefined) parts.push(`q=${f.qualityScore}`);
  if (f.computedXp !== undefined) parts.push(`xp≈${f.computedXp}`);
  if (f.answerExcerpt !== undefined) {
    parts.push(
      `answer=${JSON.stringify(truncateForDebug(f.answerExcerpt, GRADING_DEBUG_EXCERPT_MAX))}`,
    );
  }
  return parts.join(" ");
}

/**
 * Pure: best-effort summary of gradings being deterministically stripped by the
 * `idSet.size === 0` preprocess in `closeTurn.ts` (commit c3ed970). `v` is the
 * RAW pre-parse JSON value (`unknown`) — this is exactly the masking path issue
 * #22 must rule out, so we defensively pull `questionId`/`kind` from each entry
 * without trusting the shape. Returns a one-line summary naming the stripped ids.
 */
export function summariseStrippedGradings(context: string, v: unknown): string {
  if (!Array.isArray(v)) {
    return `[grading-debug] ${context} strip: non-array gradings value (type=${typeof v})`;
  }
  const ids = v.map((entry) => {
    if (entry !== null && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const qid = typeof rec.questionId === "string" ? rec.questionId : "?";
      const kind = typeof rec.kind === "string" ? rec.kind : "?";
      return `${qid}(${kind})`;
    }
    return "?(?)";
  });
  return `[grading-debug] ${context} strip: idSet empty, discarding ${v.length} grading(s): [${ids.join(", ")}]`;
}
