/**
 * Compose a developer-identifiable description from a mutation error.
 *
 * tRPC client errors carry a `data` object holding the procedure error's
 * `code` (e.g. `"TOO_MANY_REQUESTS"`) and `httpStatus` (e.g. `429`). This
 * helper surfaces both alongside the message so a toast reads cleanly for a
 * learner yet still lets a developer identify the cause from a screenshot.
 *
 * Tolerant of any input — `data` may be absent (a non-tRPC error) and the
 * input may not be an `Error` at all. The helper never throws.
 *
 * @param err - The error thrown by a tRPC mutation, or anything else.
 * @returns A single-line description, e.g.
 *   `"HTTP 429 · TOO_MANY_REQUESTS — Rate limit exceeded"`. Falls back to the
 *   bare message when no code/status is present.
 */
export function formatMutationError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";

  // tRPC client errors expose a `data` object. Read it defensively — a plain
  // Error has none, and the formatter must never throw on unexpected shapes.
  const data = readProp(err, "data");
  const httpStatus = readProp(data, "httpStatus");
  const code = readProp(data, "code");

  const tags = [
    typeof httpStatus === "number" ? `HTTP ${httpStatus}` : null,
    typeof code === "string" ? code : null,
  ].filter((tag): tag is string => tag !== null);

  return tags.length > 0 ? `${tags.join(" · ")} — ${message}` : message;
}

/** Read a property off an unknown value, or `undefined` if it is not an object. */
function readProp(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
