/**
 * Thrown when a tool-loop Step holds a tool call with neither a result nor a
 * tool-error. Cerebras rejects an unanswered tool call on replay, so one such
 * row would break every later Turn of its Wave. The attempt ends abnormally,
 * like a transport failure: no rows persist, and no harness retry runs.
 */
export class UnpairedToolCallError extends Error {
  /** `toolCallIds` names the unanswered calls. Ids only: no learner content. */
  constructor(public readonly toolCallIds: readonly string[]) {
    super(`tool loop ended abnormally: no result for tool call(s) ${toolCallIds.join(", ")}`);
    Object.setPrototypeOf(this, UnpairedToolCallError.prototype);
  }
}
