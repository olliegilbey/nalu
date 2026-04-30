/**
 * HTML-encode `&`, `<`, `>` in untrusted-but-non-user-message text destined
 * for inclusion in an XML envelope. Pure; does NOT wrap (caller supplies the
 * tag). Use `sanitiseUserInput` for user-typed text — that helper additionally
 * wraps in `<user_message>…</user_message>` so the system prompt can mark
 * the contents as data, not directives.
 *
 * This helper is for prompt-internal text whose tag is fixed by the prompt
 * author (course topic, framework JSON, blueprint outline) — wrapping with
 * `<user_message>` would corrupt the schema the model expects.
 *
 * Ampersand FIRST — encoding `<` to `&lt;` then `&` to `&amp;` would
 * re-encode the just-emitted `&` and a later decode pass could resurrect a
 * raw bracket. The order in the body of this function is load-bearing.
 */
export function escapeXmlText(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
