/** Thrown when the model's reply fails the turn validation gate; drives harness retry. */
export class ValidationGateFailure extends Error {
  /** `reason` is the gate category; `detail` is the Zod message used in retry directives. */
  constructor(
    // "tool_turn_gate": post-loop gate on tool turns (empty prose / answered
    // questions left ungraded) — see src/lib/course/waveMidTurnGate.ts.
    public readonly reason: "missing_response" | "missing_final_turn_tags" | "tool_turn_gate",
    public readonly detail: string,
  ) {
    super(`validation gate failed: ${reason} — ${detail}`);
    Object.setPrototypeOf(this, ValidationGateFailure.prototype);
  }
}
