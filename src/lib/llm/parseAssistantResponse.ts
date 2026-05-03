import type { z } from "zod";
import { extractTag } from "./extractTag";
import {
  comprehensionSignalSchema,
  assessmentSchema,
  nextLessonBlueprintSchema,
  courseSummaryUpdateSchema,
  type ComprehensionSignal,
  type AssessmentCard,
  type NextLessonBlueprint,
  type CourseSummaryUpdate,
} from "./tagVocabulary";

/**
 * Parsed model→harness teaching-turn envelope (spec §9.2).
 *
 * Validation rules:
 * - `<response>` is REQUIRED on every turn.
 * - `<comprehension_signal>` and `<assessment>` are optional; if present
 *   but inner-Zod-invalid, they are dropped silently — the rest of the
 *   turn proceeds.
 * - `<next_lesson_blueprint>` and `<course_summary_update>` are REQUIRED
 *   on a Wave's final turn (caller passes `requireFinalTurnTags`).
 *
 * `raw` is the verbatim model output for `assistant_response.content`
 * persistence.
 */
export interface ParsedAssistantResponse {
  readonly response: string;
  readonly comprehensionSignals: readonly ComprehensionSignal[];
  readonly assessment: AssessmentCard | null;
  readonly nextLessonBlueprint: NextLessonBlueprint | null;
  readonly courseSummaryUpdate: CourseSummaryUpdate | null;
  readonly raw: string;
}

export class ValidationGateFailure extends Error {
  constructor(
    public readonly reason: "missing_response" | "missing_final_turn_tags",
    public readonly detail: string,
  ) {
    super(`validation gate failed: ${reason} — ${detail}`);
    Object.setPrototypeOf(this, ValidationGateFailure.prototype);
  }
}

export interface ParseOptions {
  /** True on a Wave's final turn (turns_remaining == 0). */
  readonly requireFinalTurnTags: boolean;
}

export function parseAssistantResponse(raw: string, opts: ParseOptions): ParsedAssistantResponse {
  const response = extractTag(raw, "response");
  if (response === null) {
    throw new ValidationGateFailure("missing_response", "<response> tag absent");
  }

  // <comprehension_signal>: optional, can appear multiple times. We currently
  // only extract the first via `extractTag`; the spec contract is "≥0 per turn"
  // so a single-or-zero implementation is acceptable for MVP — the harness
  // can re-prompt if a turn truly needs multiple. (Extending to multi-extract
  // is local to this file; non-breaking for callers.)
  const csRaw = extractTag(raw, "comprehension_signal");
  const comprehensionSignals: readonly ComprehensionSignal[] = csRaw
    ? optionalParseArray(csRaw, comprehensionSignalSchema)
    : [];

  const aRaw = extractTag(raw, "assessment");
  const assessment = aRaw ? optionalParse(aRaw, assessmentSchema) : null;

  const blueprintRaw = extractTag(raw, "next_lesson_blueprint");
  const nextLessonBlueprint = blueprintRaw
    ? optionalParse(blueprintRaw, nextLessonBlueprintSchema)
    : null;

  const summaryRaw = extractTag(raw, "course_summary_update");
  const courseSummaryUpdate = summaryRaw
    ? optionalParse(summaryRaw, courseSummaryUpdateSchema)
    : null;

  if (opts.requireFinalTurnTags) {
    if (nextLessonBlueprint === null) {
      throw new ValidationGateFailure(
        "missing_final_turn_tags",
        "<next_lesson_blueprint> required on final turn",
      );
    }
    if (courseSummaryUpdate === null) {
      throw new ValidationGateFailure(
        "missing_final_turn_tags",
        "<course_summary_update> required on final turn",
      );
    }
  }

  return {
    response,
    comprehensionSignals,
    assessment,
    nextLessonBlueprint,
    courseSummaryUpdate,
    raw,
  };
}

/** Parse JSON + run Zod schema; return null on any failure. */
function optionalParse<T extends z.ZodTypeAny>(json: string, schema: T): z.infer<T> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? (parsed.data as z.infer<T>) : null;
  } catch {
    return null;
  }
}

/**
 * Parse JSON; if it's an array, validate each item via `schema` and keep the
 * passing ones. If it's a single object, validate it and wrap in an array.
 * Any failure (JSON parse error, no items pass) yields an empty array.
 */
function optionalParseArray<T extends z.ZodTypeAny>(
  json: string,
  schema: T,
): readonly z.infer<T>[] {
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value)) {
      return value
        .map((item) => schema.safeParse(item))
        .flatMap((r) => (r.success ? [r.data as z.infer<T>] : []));
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? [parsed.data as z.infer<T>] : [];
  } catch {
    return [];
  }
}
