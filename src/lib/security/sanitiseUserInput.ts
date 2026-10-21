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
 * This is the choke point for a Wave learner's replies: text the model must
 * read as data. Text with its own fixed tag (course topic, framework JSON,
 * scoping input, custom instructions) uses `escapeXmlText` directly, without
 * the wrapper.
 */
export function sanitiseUserInput(raw: string): string {
  return `<user_message>${escapeXmlText(raw)}</user_message>`;
}
