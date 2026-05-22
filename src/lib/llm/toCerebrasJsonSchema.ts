import { z } from "zod/v4";
import type { JSONSchema7 } from "ai";

/**
 * Keywords Cerebras strict-mode `response_format` rejects (per its docs).
 * Stripped from the JSON Schema before sending. The Zod side still
 * enforces them at parse-time; this only trims the wire payload.
 *
 * `$schema` is also stripped: it's top-level metadata Cerebras doesn't need,
 * and removing it saves wire chars.
 */
const FORBIDDEN_KEYWORDS = [
  "$schema",
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

/** Cerebras documented strict-mode budget: 5000 char wire schema, object-depth ≤ 10. */
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
  readonly schema: JSONSchema7;
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
 * the *post-strip* shape that Cerebras actually receives, so the prompt
 * and the wire payload agree.
 */
export function toSchemaJsonString<T>(
  schema: z.ZodType<T>,
  opts: CerebrasJsonSchemaOptions,
): string {
  return JSON.stringify(toCerebrasJsonSchema(schema, opts).schema, null, 2);
}

/**
 * Compute the JSON Schema *structural* depth of a node.
 *
 * Only increments when entering a new schema "level" — i.e. descending into
 * the value of a `properties` key or into an `items` schema. Lateral key
 * traversal (e.g. walking `type`, `description`, …) does **not** increment.
 *
 * This matches Cerebras's documented depth constraint, which is about
 * `type: "object"` nesting depth, not arbitrary key count.
 */
function schemaObjectDepth(node: unknown, depth = 0): number {
  if (typeof node !== "object" || node === null) return depth;
  if (Array.isArray(node)) {
    // e.g. `anyOf` / `oneOf` arrays — recurse into each branch, keep max
    return Math.max(...node.map((item) => schemaObjectDepth(item, depth)));
  }

  const obj = node as Record<string, unknown>;

  // Structural descent via `properties` values: each value is a sibling
  // sub-schema at the *same* depth-increment as its parent object.
  const fromProps =
    obj["properties"] != null && typeof obj["properties"] === "object"
      ? Math.max(
          ...Object.values(obj["properties"] as Record<string, unknown>).map((v) =>
            schemaObjectDepth(v, depth + 1),
          ),
        )
      : depth;

  // Structural descent via `items` (array element schema).
  const fromItems = obj["items"] != null ? schemaObjectDepth(obj["items"], depth + 1) : depth;

  // Structural descent via schema-combination keywords (anyOf / oneOf / allOf).
  const fromCombinators = (["anyOf", "oneOf", "allOf"] as const).reduce(
    (max, key) =>
      Array.isArray(obj[key])
        ? Math.max(
            max,
            ...((obj[key] as unknown[]).map((v) => schemaObjectDepth(v, depth)) as number[]),
          )
        : max,
    depth,
  );

  return Math.max(fromProps, fromItems, fromCombinators);
}

/**
 * Recursively transform a JSON Schema into its Cerebras-strict-mode form:
 * deletes forbidden keywords, rewrites `oneOf` to `anyOf`, and flattens
 * `allOf` intersections into a single merged object.
 *
 * Cerebras strict mode rejects `oneOf` outright with a 400
 * (`wrong_api_format`); `anyOf` is the supported equivalent. The rewrite is
 * exact here because Zod's discriminated unions carry a literal discriminator
 * that keeps the branches mutually exclusive regardless of oneOf-vs-anyOf.
 *
 * Cerebras strict mode likewise rejects `allOf` (400 `wrong_api_format`,
 * "Extra top level keys found"). Zod emits `allOf` for `z.intersection`
 * (`base.and(extra)` — used by the close-turn schemas, since their refined
 * base cannot take `.extend()`). See {@link flattenAllOf}.
 *
 * Pure function — returns a new value, mutates nothing.
 * Returns `unknown` because leaf nodes may be primitives.
 */
function cleanForCerebras(node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node;
  if (Array.isArray(node)) return node.map(cleanForCerebras);

  const obj = node as Record<string, unknown>;
  const cleaned = Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => !FORBIDDEN_KEYWORDS.includes(k as (typeof FORBIDDEN_KEYWORDS)[number]))
      .map(([k, v]) => [k === "oneOf" ? "anyOf" : k, cleanForCerebras(v)]),
  );
  // Flatten after recursion so the `allOf` members are already cleaned.
  return Array.isArray(cleaned["allOf"]) ? flattenAllOf(cleaned) : cleaned;
}

/**
 * Merge an `allOf` array of object-schemas into one flat object node.
 *
 * Every `allOf` Nalu produces is `[objectWithProps, objectWithProps]` — a
 * `z.intersection` of two `z.object`s with disjoint properties — so a plain
 * merge is exact: union the `properties`, union the `required`, and force the
 * canonical strict-mode object shape (`type:"object"`,
 * `additionalProperties:false`). Non-object intersections are not generated
 * anywhere in the codebase, so they are deliberately not handled.
 *
 * @param node - a cleaned node whose `allOf` is a non-empty array of objects.
 */
function flattenAllOf(node: Record<string, unknown>): Record<string, unknown> {
  const { allOf, ...rest } = node;
  const members = allOf as ReadonlyArray<Record<string, unknown>>;
  const mergedProperties = members.reduce<Record<string, unknown>>(
    (acc, member) => ({ ...acc, ...((member["properties"] as Record<string, unknown>) ?? {}) }),
    {},
  );
  const mergedRequired = members.flatMap((member) =>
    Array.isArray(member["required"]) ? (member["required"] as readonly string[]) : [],
  );
  return {
    ...rest,
    type: "object",
    properties: mergedProperties,
    required: [...new Set(mergedRequired)],
    additionalProperties: false,
  };
}
