import { getDueConceptsByCourse, getConceptsByCourse } from "@/db/queries/concepts";
import { escapeXmlText } from "@/lib/security/escapeXmlText";

/**
 * Minimal projection of a concept row used to render the close-turn injection.
 *
 * We collapse the wider `Concept` row to just the fields the prompt needs
 * (name, tier, lastQuality) so callers and tests can construct synthetic
 * entries without touching the DB schema. `lastQuality` is the integer SM-2
 * quality (0–5) or `null` for never-assessed concepts.
 */
export interface ConceptForInjection {
  readonly name: string;
  readonly tier: number;
  readonly lastQuality: number | null;
}

/**
 * Fetch concepts that have never been assessed AND match `currentTier`.
 *
 * `getConceptsByCourse` returns every concept on the course; we filter to
 * the untaught + current-tier slice in TS rather than a dedicated query —
 * concept lists per course are small (single digits to ~hundreds), so the
 * scan is cheap and we avoid a second SQL surface.
 *
 * Sort: `getConceptsByCourse` is explicitly unordered, but the rendered
 * block becomes part of a cached prompt prefix on the close turn — any
 * non-determinism in row order breaks cache reuse across requests. Sort
 * by `name` using raw string compare (NOT `localeCompare`, which is
 * locale-sensitive) so the byte sequence is stable.
 */
export async function getFreshConcepts(
  courseId: string,
  currentTier: number,
): Promise<readonly ConceptForInjection[]> {
  const all = await getConceptsByCourse(courseId);
  const filtered = all
    .filter((c) => c.tier === currentTier && c.lastReviewedAt === null)
    .map((c) => ({ name: c.name, tier: c.tier, lastQuality: c.lastQualityScore }));
  return filtered.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Fetch concepts SM-2-due as of `now`.
 *
 * Thin wrapper over `getDueConceptsByCourse` that narrows the row to the
 * projection used by `renderConceptInjection`. `now` is caller-supplied to
 * keep the call site deterministic in tests (matches the underlying query's
 * `now: Date` contract).
 *
 * Sort: delegated to the underlying query, which orders by
 * `(nextReviewAt ASC, id ASC)`. That ordering is part of the cache-stability
 * contract — keep it in sync if the query is ever swapped.
 */
export async function getDueConcepts(
  courseId: string,
  now: Date,
): Promise<readonly ConceptForInjection[]> {
  const rows = await getDueConceptsByCourse(courseId, now);
  return rows.map((c) => ({ name: c.name, tier: c.tier, lastQuality: c.lastQualityScore }));
}

/**
 * Render the `<concepts_for_next_wave>` block injected on the close turn.
 *
 * Empty subblocks emit `(none)` so the model has an unambiguous signal in
 * the consolidation edge case (spec §5.4) — distinguishes "nothing to inject"
 * from a malformed envelope.
 *
 * Names are run through `escapeXmlText` because concept names originate from
 * LLM-generated scoping output and could legally contain `<`, `>`, or `&`
 * that would otherwise corrupt the XML envelope.
 */
export function renderConceptInjection(
  fresh: readonly ConceptForInjection[],
  due: readonly ConceptForInjection[],
): string {
  // Build the body of each subblock independently so the empty-case `(none)`
  // placeholder lives on its own line — the test asserts the exact triple-line
  // shape `<tag>\n(none)\n</tag>`.
  const freshBody =
    fresh.length === 0
      ? "(none)"
      : fresh.map((c) => `- "${escapeXmlText(c.name)}" (tier ${c.tier})`).join("\n");
  const dueBody =
    due.length === 0
      ? "(none)"
      : due
          .map(
            (c) =>
              // Append the last quality score only when present — never-assessed
              // due rows (shouldn't normally appear in the due set, but the type
              // permits null) render without the score suffix.
              `- "${escapeXmlText(c.name)}" (tier ${c.tier}${c.lastQuality === null ? "" : `, last scored ${c.lastQuality}/5`})`,
          )
          .join("\n");
  return [
    "<concepts_for_next_wave>",
    "<fresh_at_current_tier>",
    freshBody,
    "</fresh_at_current_tier>",
    "<review_due>",
    dueBody,
    "</review_due>",
    "</concepts_for_next_wave>",
  ].join("\n");
}
