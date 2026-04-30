import { escapeXmlText } from "./escapeXmlText";

/**
 * Sanitise user-supplied text before it enters an LLM prompt.
 *
 * Two-step defence:
 *   1. HTML-encode `&`, `<`, `>` via `escapeXmlText` so no tag boundaries
 *      survive in the payload.
 *   2. Wrap the encoded payload in `<user_message>…</user_message>` so the
 *      system prompt can instruct the model to treat contents as data.
 *
 * This is the sole choke point for untrusted USER text entering a prompt.
 * For non-user text that still needs XML escaping (course topic, framework
 * JSON, etc.) use `escapeXmlText` directly without the wrapper.
 */
export function sanitiseUserInput(raw: string): string {
  return `<user_message>${escapeXmlText(raw)}</user_message>`;
}
