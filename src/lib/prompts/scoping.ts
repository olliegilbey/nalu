import { escapeXmlText } from "@/lib/security/escapeXmlText";
import type { ScopingSeedInputs } from "@/lib/types/context";

/**
 * Slim system prompt for a scoping pass.
 *
 * Contains only: persona, topic interpolation, the one-line "reply in JSON
 * matching the attached schema" rule. Per-stage instructions are NOT here —
 * they live entirely on each stage schema's `.describe()` annotations, which
 * Cerebras tokenises into the decoder context as part of the wire-side
 * `response_format`. Every turn's schema rides the wire; the system prompt
 * only carries the contract "reply with a single JSON object matching it".
 *
 * Emitted exactly once per scoping pass — `renderContext` only renders a
 * `role: "system"` row when one is present at the top of the message log.
 * Subsequent turns append user/assistant rows; the prefix stays byte-stable.
 */
export function renderScopingSystem(inputs: ScopingSeedInputs): string {
  return `<role>
You are Nalu, an expert teacher and tutor. You are building a bespoke course for a learner on the topic of <scoping_topic>${escapeXmlText(inputs.topic)}</scoping_topic>.

Each turn a response schema is attached to your request. Reply with a single JSON object whose top-level keys are EXACTLY the keys named in that schema's "required" array, and whose value shapes match the schema's "properties". Field-level guidance lives in each property's "description" — read it before generating. Do not invent fields the schema does not declare. No prose outside the JSON object.
</role>`;
}

/** Inputs for {@link renderStageEnvelope}; the per-turn user-role wrapper params. */
export interface RenderStageEnvelopeParams {
  /** Bare stage label — appears verbatim inside `<stage>...</stage>`. */
  readonly stage: "clarify" | "generate framework" | "generate baseline" | "close scoping";
  /** Learner input — XML-escaped before embedding. May be empty for stage-only envelopes. */
  readonly learnerInput: string;
}

/**
 * Build the per-turn user-role envelope. Minimal by design — the schema's
 * descriptions carry per-field guidance (delivered via the wire-side
 * `response_format`); this wrapper only names the stage and surfaces the
 * learner's input. Cache-prefix stability: the only variable bytes per turn
 * are the stage label and the escaped input.
 */
export function renderStageEnvelope(params: RenderStageEnvelopeParams): string {
  return `<stage>${params.stage}</stage>
<learner_input>
${escapeXmlText(params.learnerInput)}
</learner_input>`;
}
