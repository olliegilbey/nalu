/**
 * Sanitise user-supplied text before it enters an LLM prompt.
 *
 * Two-step defence:
 *   1. HTML-encode `&`, `<`, `>` so no tag boundaries survive in the payload.
 *   2. Wrap the encoded payload in `<user_message>…</user_message>` so the
 *      system prompt can instruct the model to treat contents as data.
 *
 * Ampersand is encoded FIRST — otherwise encoding `<` to `&lt;` and then
 * encoding `&` would double-escape and a later decoding pass could
 * resurrect a raw bracket.
 *
 * This is the sole choke point for untrusted text entering a prompt.
 */
export function sanitiseUserInput(raw: string): string {
  const encoded = raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<user_message>${encoded}</user_message>`;
}
