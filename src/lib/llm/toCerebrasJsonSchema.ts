import { z } from "zod/v4";
import { jsonSchema, type JSONSchema7, type Schema } from "ai";
import { cleanForCerebras, schemaObjectDepth } from "./toCerebrasJsonSchema.transform";

/** Cerebras documented strict-mode budget: 5000 char wire schema, object-depth ≤ 10. */
const MAX_CHARS = 5000;
const MAX_DEPTH = 10;

/** Options for {@link toCerebrasJsonSchema}; wire `response_format.json_schema` metadata. */
export interface CerebrasJsonSchemaOptions {
  /** Schema name (passed as `response_format.json_schema.name`). */
  readonly name: string;
  /** Optional description (passed as `response_format.json_schema.description`). */
  readonly description?: string;
}

/** Wire-shape returned to callers — what AI SDK's `responseFormat` consumes. */
export interface CerebrasResponseFormat {
  readonly type: "json";
  readonly name: string;
  readonly description?: string;
  readonly schema: JSONSchema7;
}

/**
 * Convert a Zod schema to a Cerebras-strict-mode JSON Schema and wrap it in
 * the AI SDK's `responseFormat` shape. Strips forbidden keywords, rewrites
 * `oneOf` → `anyOf`, flattens `allOf`, and asserts size/depth at build time.
 *
 * The wire-format transforms live in `./toCerebrasJsonSchema.transform`; this
 * file owns the public API and the Cerebras budget enforcement.
 */
export function toCerebrasJsonSchema<T>(
  schema: z.ZodType<T>,
  opts: CerebrasJsonSchemaOptions,
): CerebrasResponseFormat {
  const raw = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;

  // Pre-pass: measure structural depth before stripping (avoids conflating
  // call-stack depth with schema object depth).
  const actual = schemaObjectDepth(raw);
  if (actual > MAX_DEPTH) {
    throw new Error(
      `toCerebrasJsonSchema(${opts.name}): schema depth ${actual} exceeds Cerebras ${MAX_DEPTH} strict-mode budget`,
    );
  }

  const cleaned = cleanForCerebras(raw);
  const serialised = JSON.stringify(cleaned);
  if (serialised.length > MAX_CHARS) {
    throw new Error(
      `toCerebrasJsonSchema(${opts.name}): schema is ${serialised.length} chars, exceeds Cerebras ${MAX_CHARS}-char strict-mode budget`,
    );
  }
  return {
    type: "json",
    name: opts.name,
    description: opts.description,
    // Cast is safe: `raw` is always an object, so `cleanForCerebras(raw)` is too.
    schema: cleaned as JSONSchema7,
  };
}

/**
 * Convenience: stringify just the cleaned schema body (no wrapper) for
 * inlining into the user-side prompt envelope.
 *
 * Why this exists: `response_format` on the wire is documented but
 * historically free-tier Cerebras models (notably `llama3.1-8b`) ignore
 * strict-mode constrained decoding and emit free-form JSON. Inlining the
 * same schema bytes into the user envelope gives the model an in-context
 * shape contract it can read directly, which empirically fixes the issue
 * without forcing a model upgrade.
 *
 * The string returned here is byte-equivalent to
 * `JSON.stringify(toCerebrasJsonSchema(schema, opts).schema, null, 2)` — i.e.
 * the *post-strip* shape that Cerebras actually receives, so the prompt and
 * the wire payload agree.
 */
export function toSchemaJsonString<T>(
  schema: z.ZodType<T>,
  opts: CerebrasJsonSchemaOptions,
): string {
  return JSON.stringify(toCerebrasJsonSchema(schema, opts).schema, null, 2);
}

/**
 * Wrap a Zod schema as an AI SDK `Schema` whose wire shape is the
 * Cerebras-cleaned JSON Schema and whose validator is Zod `safeParse`.
 *
 * WHY: `Output.object({ schema })` would otherwise derive JSON Schema from
 * Zod itself, bypassing `cleanForCerebras` (keyword stripping, oneOf→anyOf,
 * the 5000-char/depth-10 budget asserts). Feeding the SDK this wrapper keeps
 * the wire bytes identical to the pre-Output implementation while letting
 * the SDK run our full Zod validation — refines included — and throw
 * `NoObjectGeneratedError` with the ZodError as `cause` on failure.
 */
export function toOutputSchema<T>(
  schema: z.ZodType<T>,
  opts: CerebrasJsonSchemaOptions,
): Schema<T> {
  const wire = toCerebrasJsonSchema(schema, opts);
  return jsonSchema<T>(wire.schema, {
    validate: (value) => {
      const result = schema.safeParse(value);
      return result.success
        ? { success: true, value: result.data }
        : { success: false, error: result.error };
    },
  });
}

/**
 * Recursively drop `null`-valued OBJECT PROPERTIES. Array elements are left
 * untouched (a null element is data, not an omitted field). Used by
 * {@link toToolInputSchema} to absorb the tool-trained-model habit of
 * emitting explicit `null` for inapplicable optional fields.
 */
function stripNullsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullsDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNullsDeep(v)]),
    );
  }
  return value;
}

/**
 * Wrap a Zod schema as an AI SDK `Schema` for TOOL INPUTS (the tool-channel
 * analogue of {@link toOutputSchema}).
 *
 * WHY the split (live probe, docs/status/2026-07-06-tool-call-probe-verdict.md):
 * - Wire bytes are the bare-`.optional()` Cerebras-cleaned shape. Null unions
 *   (`.nullish()` → `anyOf: [..., {type:"null"}]`) crater gpt-oss-120b's
 *   tool-call reliability from ~95% to ~44% and cause record→array confusion.
 * - Validation strips explicit `null` object properties BEFORE Zod: models
 *   trained on OpenAI strict-mode tools emit `"field": null` for inapplicable
 *   optionals, which bare `.optional()` would reject.
 */
export function toToolInputSchema<T>(
  schema: z.ZodType<T>,
  opts: CerebrasJsonSchemaOptions,
): Schema<T> {
  const wire = toCerebrasJsonSchema(schema, opts);
  return jsonSchema<T>(wire.schema, {
    validate: (value) => {
      const result = schema.safeParse(stripNullsDeep(value));
      return result.success
        ? { success: true, value: result.data }
        : { success: false, error: result.error };
    },
  });
}
