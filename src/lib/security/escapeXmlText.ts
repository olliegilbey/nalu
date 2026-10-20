/**
 * HTML-encode `&`, `<`, `>` in untrusted-but-non-user-message text destined
 * for inclusion in an XML envelope. Pure; does NOT wrap (caller supplies the
 * tag). Use `sanitiseUserInput` for a Wave learner's reply — that helper
 * additionally wraps in `<user_message>…</user_message>` so the system prompt
 * can mark the contents as data, not directives.
 *
 * This helper is for text whose tag is fixed by the prompt author (course
 * topic, framework JSON, blueprint outline) — wrapping with `<user_message>`
 * would corrupt the schema the model expects. The learner's custom
 * instructions use it too, inside `<custom_instructions>`: the model honours
 * them as preferences, so a data wrapper would defeat them (issue #236).
 *
 * Ampersand FIRST — encoding `<` to `&lt;` then `&` to `&amp;` would
 * re-encode the just-emitted `&` and a later decode pass could resurrect a
 * raw bracket. The order in the body of this function is load-bearing.
 */
export function escapeXmlText(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
