/**
 * Wire-format transforms applied to `z.toJSONSchema` output before it is sent
 * to Cerebras strict mode. Pure functions, no side effects.
 *
 * Extracted from `toCerebrasJsonSchema.ts` so the main file stays under the
 * 200-line rule. The public entry points (`toCerebrasJsonSchema`,
 * `toSchemaJsonString`) compose the helpers exported here.
 */

/**
 * Keywords Cerebras strict-mode `response_format` rejects (per its docs).
 * Stripped from the JSON Schema before sending. The Zod side still enforces
 * them at parse-time; this only trims the wire payload.
 *
 * `$schema` is also stripped: it's top-level metadata Cerebras doesn't need,
 * and removing it saves wire chars.
 */
export const FORBIDDEN_KEYWORDS = [
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
export function schemaObjectDepth(node: unknown, depth = 0): number {
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
export function cleanForCerebras(node: unknown): unknown {
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
 * `additionalProperties:false`).
 *
 * Two fail-fast guards keep the assumptions explicit so a future intersection
 * shape that breaks them fails loud at build time instead of silently
 * weakening the wire schema:
 *   - every member must be `type: "object"`;
 *   - property keys across members must be disjoint.
 *
 * @param node - a cleaned node whose `allOf` is a non-empty array of objects.
 */
export function flattenAllOf(node: Record<string, unknown>): Record<string, unknown> {
  const { allOf, ...rest } = node;
  const members = allOf as ReadonlyArray<Record<string, unknown>>;

  // Guard 1: every member must be a plain object schema. A non-object member
  // has no defensible flatten semantics — refuse to silently mismerge.
  const nonObjectIdx = members.findIndex((m) => m["type"] !== "object");
  if (nonObjectIdx !== -1) {
    throw new Error(
      `flattenAllOf: allOf member ${nonObjectIdx} is not an object schema (type=${JSON.stringify(
        members[nonObjectIdx]!["type"],
      )}); refusing to flatten`,
    );
  }

  // Guard 2: property keys must be disjoint. A duplicate means one branch's
  // definition would silently overwrite the other; force the caller to
  // reconcile the schemas explicitly.
  const allPropKeys = members.flatMap((m) =>
    Object.keys((m["properties"] as Record<string, unknown> | undefined) ?? {}),
  );
  const dupKey = allPropKeys.find((k, i) => allPropKeys.indexOf(k) !== i);
  if (dupKey !== undefined) {
    throw new Error(
      `flattenAllOf: duplicate property "${dupKey}" across allOf members; cannot safely flatten`,
    );
  }

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
