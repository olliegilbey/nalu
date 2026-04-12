/**
 * Extract the inner text of the first occurrence of `<tag>…</tag>` from
 * `text`. Returns `null` if the tag is absent or unclosed.
 *
 * Needed because PRD §5 conversational turns mix free-form prose with
 * embedded structured XML blocks (e.g. `<assessment>` / `<comprehension_signal>`).
 * `generateObject` covers wholly-structured calls; this covers the
 * prose-plus-XML case.
 *
 * Contract:
 *   - First match wins (non-greedy).
 *   - Surrounding whitespace in the captured body is trimmed — models
 *     often pad tag contents with newlines.
 *   - Tag name is matched with a word boundary so `<assessment>` does
 *     not match `<assessments>`.
 *   - Tag name is regex-escaped defensively; callers pass static names
 *     today but should not have to think about it.
 */
export function extractTag(text: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`);
  const match = re.exec(text);
  return match ? (match[1]?.trim() ?? null) : null;
}
