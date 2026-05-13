import { escapeXmlText } from "@/lib/security/escapeXmlText";
import type { ScopingSeedInputs } from "@/lib/types/context";

/**
 * Slim system prompt for a scoping pass.
 *
 * Contains only: persona, topic interpolation, the one-line "reply in JSON
 * matching the attached schema" rule. Per-stage instructions are NOT here —
 * they live entirely on each stage schema's `.describe()` annotations,
 * which Cerebras strict mode tokenises into the decoder context as part of
 * `response_format`. The wire-side rule "this turn's schema is attached to
 * THIS turn's user envelope" is the only contract the system prompt
 * carries.
 *
 * Emitted exactly once per scoping pass — `renderContext` only renders a
 * `role: "system"` row when one is present at the top of the message log.
 * Subsequent turns append user/assistant rows; the prefix stays byte-stable.
 */
export function renderScopingSystem(inputs: ScopingSeedInputs): string {
  return `<role>
You are Nalu, an expert teacher and tutor. You are building a bespoke course for a learner on the topic of <scoping_topic>${escapeXmlText(inputs.topic)}</scoping_topic>.

Each turn, reply with a single JSON object matching the response schema attached to that turn. Field-level guidance lives in the schema's description metadata — read it carefully before generating. No prose outside the JSON object.
</role>`;
}

export interface RenderStageEnvelopeParams {
  /** Bare stage label — appears verbatim inside `<stage>...</stage>`. */
  readonly stage: "clarify" | "generate framework" | "generate baseline" | "grade baseline";
  /** Learner input — XML-escaped before embedding. May be empty for stage-only envelopes. */
  readonly learnerInput: string;
}

/**
 * Build the per-turn user-role envelope. Minimal by design — the schema's
 * descriptions carry per-field guidance; this wrapper just names the stage
 * and surfaces the learner's input. Cache-prefix stability: the only
 * variable bytes per turn are the stage label and the escaped input.
 */
export function renderStageEnvelope(params: RenderStageEnvelopeParams): string {
  return `<stage>${params.stage}</stage>
<learner_input>
${escapeXmlText(params.learnerInput)}
</learner_input>`;
}
