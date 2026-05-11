import { z } from "zod/v4";
import { extractTag } from "@/lib/llm/extractTag";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import {
  baselineSchema,
  frameworkSchema,
  type BaselineAssessment,
  type Framework,
} from "@/lib/prompts";

/**
 * Per-stage parsers for scoping turns (spec §3.3).
 *
 * Each parser inspects the raw LLM output and either returns the validated
 * payload or throws `ValidationGateFailure` with a message authored to be
 * piped back to the model verbatim as the retry directive. The error
 * message is load-bearing — phrase it the way a teacher would, naming the
 * specific tag and the specific constraint.
 */

export interface ParsedClarifyResponse {
  readonly questions: readonly string[];
  readonly raw: string;
}
export interface ParsedFrameworkResponse {
  readonly framework: Framework;
  readonly raw: string;
}
export interface ParsedBaselineResponse {
  readonly baseline: BaselineAssessment;
  readonly raw: string;
}

// Local schema for the clarify stage. Lives here rather than in
// `src/lib/prompts/` because the contract is just "JSON array of 2–4 short
// question strings" — the prompts package owns the *prompt* text, this owns
// the *parse-side* validation. Bounds chosen to mirror the prompt wording.
const clarifyQuestionsSchema = z.array(z.string().min(1).max(300)).min(2).max(4);

/**
 * Parse a tag body as JSON, throwing `ValidationGateFailure` with the supplied
 * retry directive when the body is not valid JSON. Returns `unknown` because
 * the caller is responsible for Zod-validating the shape next.
 *
 * Lives as a tiny helper rather than inline so each parser stays
 * `const`-only (functional/no-let), and so the JSON-failure directive is
 * authored next to the schema-failure directive in the caller.
 */
function parseTagJson(body: string, jsonFailureDirective: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ValidationGateFailure("missing_response", jsonFailureDirective);
  }
}

/**
 * Parse the clarify-stage assistant turn. Expects `<questions>[...]</questions>`
 * containing a JSON array of 2–4 short question strings. Other tags
 * (notably `<response>`) are inspected by the outer turn parser, not here —
 * this parser only owns the structured payload.
 */
export function parseClarifyResponse(raw: string): ParsedClarifyResponse {
  const tag = extractTag(raw, "questions");
  if (tag === null) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your response was missing the required <questions>[...]</questions> tag. ` +
        `Reply with the full clarifying-questions payload inside <questions>...</questions> ` +
        `containing a JSON array of 2 to 4 short question strings. Keep the rest of your ` +
        `<response>...</response> prose.`,
    );
  }
  const parsed = parseTagJson(
    tag,
    `The contents of <questions> were not valid JSON. Reply with a corrected ` +
      `<questions>[...]</questions> payload — a JSON array of 2 to 4 short question strings.`,
  );
  const safe = clarifyQuestionsSchema.safeParse(parsed);
  if (!safe.success) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your <questions> payload failed validation: ${safe.error.message}. ` +
        `Reply with a corrected <questions>[...]</questions> array of 2 to 4 non-empty strings.`,
    );
  }
  return { questions: safe.data, raw };
}

/**
 * Parse the framework-stage assistant turn. Expects `<framework>{...}</framework>`
 * matching `frameworkSchema` (tiers, estimatedStartingTier, baselineScopeTiers).
 * On Zod failure we surface `safe.error.message` verbatim so the model sees the
 * precise field/path it broke — that text becomes the retry directive.
 */
export function parseFrameworkResponse(raw: string): ParsedFrameworkResponse {
  const tag = extractTag(raw, "framework");
  if (tag === null) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your response was missing the required <framework>{...}</framework> tag. ` +
        `Reply with the full framework JSON inside <framework>...</framework>. The rest of ` +
        `your <response>...</response> prose is fine.`,
    );
  }
  const parsed = parseTagJson(
    tag,
    `The contents of <framework> were not valid JSON. Reply with a corrected ` +
      `<framework>{...}</framework> payload matching the schema you were given.`,
  );
  const safe = frameworkSchema.safeParse(parsed);
  if (!safe.success) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your <framework> payload failed validation: ${safe.error.message}. ` +
        `Re-emit a corrected <framework>{...}</framework> payload that satisfies every ` +
        `constraint named above. Pay particular attention to the tiers field if it appears ` +
        `in the error.`,
    );
  }
  return { framework: safe.data, raw };
}

export interface ParseBaselineOptions {
  /**
   * Tier numbers the model was told to draw baseline questions from
   * (typically `framework.baselineScopeTiers`). Any question whose tier is
   * outside this list fails the orchestrator-level invariant.
   */
  readonly scopeTiers: readonly number[];
}

/**
 * Parse the baseline-stage assistant turn. Expects `<baseline>{...}</baseline>`
 * matching `baselineSchema`. Beyond the schema we enforce two
 * orchestrator-level invariants previously handled in the lib step:
 *   1. Every question's `tier` must be one of `opts.scopeTiers`.
 *   2. Question `id`s must be unique.
 * Both produce retry-directive errors that name the offending ids/tiers so
 * the model can self-correct.
 */
export function parseBaselineResponse(
  raw: string,
  opts: ParseBaselineOptions,
): ParsedBaselineResponse {
  const tag = extractTag(raw, "baseline");
  if (tag === null) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your response was missing the required <baseline>{...}</baseline> tag. ` +
        `Reply with the full baseline-assessment JSON inside <baseline>...</baseline>.`,
    );
  }
  const parsed = parseTagJson(
    tag,
    `The contents of <baseline> were not valid JSON. Reply with a corrected ` +
      `<baseline>{...}</baseline> payload matching the schema you were given.`,
  );
  const safe = baselineSchema.safeParse(parsed);
  if (!safe.success) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your <baseline> payload failed schema validation: ${safe.error.message}. ` +
        `Re-emit a corrected <baseline>{...}</baseline>.`,
    );
  }
  // Orchestrator-level invariants (moved out of the prior lib step).
  // Scope check: every question.tier must be inside opts.scopeTiers.
  const outOfScope = safe.data.questions.filter((q) => !opts.scopeTiers.includes(q.tier));
  if (outOfScope.length > 0) {
    const ids = outOfScope.map((q) => `${q.id}(tier=${q.tier})`).join(", ");
    throw new ValidationGateFailure(
      "missing_response",
      `Your baseline questions reference tiers outside the requested scope [${opts.scopeTiers.join(", ")}]. ` +
        `Offending questions: ${ids}. Every question's tier must be one of the scope numbers. ` +
        `Re-emit <baseline>{...}</baseline> with all questions inside the scope.`,
    );
  }
  // Duplicate-id scan, functional style (matches old generateBaseline.ts).
  const ids = safe.data.questions.map((q) => q.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your baseline questions have duplicate ids: ${dupes.join(", ")}. ` +
        `Every question id must be unique (e.g. b1, b2, b3, ...). ` +
        `Re-emit <baseline>{...}</baseline> with unique ids.`,
    );
  }
  return { baseline: safe.data, raw };
}
