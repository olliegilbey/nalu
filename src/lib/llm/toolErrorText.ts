import { getErrorMessage } from "@ai-sdk/provider";

/**
 * The text the AI SDK sends the model for a failed tool call. In-loop, the
 * SDK answers a `tool-error` with `{type: "error-text", value:
 * getErrorMessage(error)}` (ai@6.0.306 `createToolModelOutput`, error mode
 * "text"). Persisting the same string keeps the replayed Context byte-stable.
 */
export function toolErrorText(error: unknown): string {
  return getErrorMessage(error);
}
