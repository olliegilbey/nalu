import { z } from "zod/v4";

/**
 * Keywords Cerebras strict-mode `response_format` rejects (per its docs).
 * Stripped from the JSON Schema before sending. The Zod side still
 * enforces them at parse-time; this only trims the wire payload.
 */
const FORBIDDEN_KEYWORDS = [
  "minItems",
  "maxItems",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "format",
  "$ref",
] as const;

/** Cerebras documented strict-mode budget: 5000 char wire schema, depth ≤ 10. */
const MAX_CHARS = 5000;
const MAX_DEPTH = 10;

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
  readonly schema: Record<string, unknown>;
}

/**
 * Convert a Zod schema to a Cerebras-strict-mode JSON Schema and wrap it
 * in the AI SDK's `responseFormat` shape. Strips forbidden keywords and
 * asserts size/depth at build time.
 */
export function toCerebrasJsonSchema<T>(
  schema: z.ZodType<T>,
  opts: CerebrasJsonSchemaOptions,
): CerebrasResponseFormat {
  const raw = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  const stripped = stripForbidden(raw, 0);
  const serialised = JSON.stringify(stripped);
  if (serialised.length > MAX_CHARS) {
    throw new Error(
      `toCerebrasJsonSchema(${opts.name}): schema is ${serialised.length} chars, exceeds Cerebras ${MAX_CHARS}-char strict-mode budget`,
    );
  }
  return {
    type: "json",
    name: opts.name,
    description: opts.description,
    schema: stripped,
  };
}

/**
 * Recursively walk the schema, deleting forbidden keywords and asserting
 * the depth budget. Pure function — returns a new object, mutates nothing.
 */
function stripForbidden(node: unknown, depth: number): Record<string, unknown> {
  if (depth > MAX_DEPTH) {
    throw new Error(`toCerebrasJsonSchema: schema depth exceeds ${MAX_DEPTH}`);
  }
  if (typeof node !== "object" || node === null) {
    return node as Record<string, unknown>;
  }
  if (Array.isArray(node)) {
    return node.map((item) => stripForbidden(item, depth + 1)) as unknown as Record<
      string,
      unknown
    >;
  }
  // Object: shallow-copy without forbidden keys; recurse into each value.
  const obj = node as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => !FORBIDDEN_KEYWORDS.includes(k as (typeof FORBIDDEN_KEYWORDS)[number]))
      .map(([k, v]) => [k, stripForbidden(v, depth + 1)]),
  );
}
