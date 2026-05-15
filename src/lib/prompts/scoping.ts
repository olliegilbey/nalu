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

Each turn you receive a <response_schema> block inside the user message. Reply with a single JSON object whose top-level keys are EXACTLY the keys named in that schema's "required" array, and whose value shapes match the schema's "properties". Field-level guidance lives in each property's "description" — read it before generating. Do not invent fields the schema does not declare. No prose outside the JSON object.
</role>`;
}

export interface RenderStageEnvelopeParams {
  /** Bare stage label — appears verbatim inside `<stage>...</stage>`. */
  readonly stage: "clarify" | "generate framework" | "generate baseline" | "close scoping";
  /** Learner input — XML-escaped before embedding. May be empty for stage-only envelopes. */
  readonly learnerInput: string;
  /**
   * Optional JSON-Schema string for the response shape this turn must
   * match. Inlined into the envelope verbatim inside `<response_schema>`.
   * Should be the same post-strip shape the wire `response_format` sees,
   * built via `toSchemaJsonString`. Inlining is necessary because some
   * free-tier Cerebras models (llama3.1-8b) silently ignore
   * `response_format: { type: "json_schema", strict: true }` and emit
   * free-form JSON; an in-context schema gives them a shape contract
   * they actually read.
   *
   * Lives on the user envelope, NOT the system prompt, because the
   * schema differs per stage and the system prompt must stay cache-prefix
   * stable across all turns of a scoping pass.
   */
  readonly responseSchema?: string;
}

/**
 * Build the per-turn user-role envelope. Minimal by design — the schema's
 * descriptions carry per-field guidance; this wrapper names the stage,
 * surfaces the learner's input, and (when supplied) inlines the response
 * schema as a redundant in-context contract. Cache-prefix stability: the
 * only variable bytes per turn are the stage label, the escaped input,
 * and (per stage) the schema JSON.
 */
export function renderStageEnvelope(params: RenderStageEnvelopeParams): string {
  // Schema is emitted as a *raw* JSON literal — no XML escaping, because
  // its contents are first-party (we built it) and JSON has no `<`/`>`
  // tokens that would collide with the surrounding tags in practice. The
  // model needs to parse it as JSON to read the field shapes.
  const schemaBlock =
    params.responseSchema !== undefined
      ? `\n<response_schema>\n${params.responseSchema}\n</response_schema>`
      : "";
  return `<stage>${params.stage}</stage>
<learner_input>
${escapeXmlText(params.learnerInput)}
</learner_input>${schemaBlock}`;
}
