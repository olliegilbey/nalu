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
 * Guardrail (AGENTS.md): learner content and LLM outputs never reach
 * production logs. `isGradingDebugEnabled()` is the single gate every content
 * log MUST be wrapped in, and it refuses production outright. Excerpts are also
 * truncated here, so even flag-on output caps how much learner text is emitted.
 */

/** True when `LLM_DEBUG_GRADINGS=1` outside production; the one gate for grading-debug output. */
export function isGradingDebugEnabled(): boolean {
  // Hard refusal in production, mirroring the `LLM_DEVTOOLS` double gate in
  // `src/lib/llm/provider.ts`. Vercel sets NODE_ENV=production for Production
  // AND Preview (docs/DEPLOY.md), and both serve real anonymous users, so a
  // copied `.env.local` with the flag on still logs nothing there. Dev
  // (`just dev`) and smoke (`just smoke`, NODE_ENV=test) keep the diagnosis.
  if (process.env.NODE_ENV === "production") return false;
  // Read from `process.env`, not `getEnv()`: like LLM_TELEMETRY / LLM_DEVTOOLS
  // it stays out of the boot-time schema, so a typo cannot crash the app.
  return process.env.LLM_DEBUG_GRADINGS === "1";
}

/** Max chars of a learner free-text excerpt in a debug line — redaction cap. */
export const GRADING_DEBUG_EXCERPT_MAX = 80;

/** Max chars of a raw LLM candidate in a parse-failure debug line. */
export const GRADING_DEBUG_CANDIDATE_MAX = 600;

/** Pure: flatten whitespace to single spaces, then cap at `max` chars with a trailing `…`. */
export function truncateForDebug(s: string, max: number): string {
  // Flattening keeps one grading on one log line; learner answers may hold newlines.
  const flattened = s.replace(/\s+/g, " ").trim();
  if (flattened.length <= max) return flattened;
  return `${flattened.slice(0, max)}…`;
}

/** Fields for one `formatGradingDebugLine` row. Free-text-only fields are optional. */
export interface GradingDebugFields {
  /** Which close path logged the line. */
  readonly context: "wave-close" | "scoping-close";
  /** Raw question id from the model's grading. */
  readonly questionId: string;
  /** The grading's discriminator. */
  readonly kind: "free-text" | "mc-index";
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

/** Pure: render one grading as a single `[grading-debug]` line. */
export function formatGradingDebugLine(f: GradingDebugFields): string {
  // Only present fields are emitted: an `mc-index` grading stays compact and a
  // free-text grading carries verdict/quality/xp/excerpt. The excerpt is capped
  // at GRADING_DEBUG_EXCERPT_MAX whatever the caller passes.
  const parts = [
    "[grading-debug]",
    f.context,
    `qid=${JSON.stringify(f.questionId)}`,
    `kind=${f.kind}`,
    f.verdict !== undefined ? `verdict=${f.verdict}` : undefined,
    f.qualityScore !== undefined ? `q=${f.qualityScore}` : undefined,
    f.computedXp !== undefined ? `xp≈${f.computedXp}` : undefined,
    f.answerExcerpt !== undefined
      ? `answer=${JSON.stringify(truncateForDebug(f.answerExcerpt, GRADING_DEBUG_EXCERPT_MAX))}`
      : undefined,
  ];
  return parts.filter((p) => p !== undefined).join(" ");
}

/** Pure: one-line summary of the gradings the empty-idSet preprocess in `closeTurn.ts` discards. */
export function summariseStrippedGradings(context: string, v: unknown): string {
  // `v` is the RAW pre-parse value. This strip (commit c3ed970) is the masking
  // path issue #22 must rule out, so pull `questionId`/`kind` from each entry
  // defensively, without trusting the shape.
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
