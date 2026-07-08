import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  toCerebrasJsonSchema,
  toOutputSchema,
  toSchemaJsonString,
  toToolInputSchema,
} from "./toCerebrasJsonSchema";
import { clarifySchema } from "@/lib/prompts/clarify";
import { frameworkSchema } from "@/lib/prompts/framework";
import { waveMidTurnSchema } from "@/lib/prompts/waveTurn";
import { makeWaveCloseSchema } from "@/lib/prompts/waveClose";
import { makeScopingCloseSchema } from "@/lib/prompts/scopingClose";
import type { MakeCloseTurnBaseSchemaParams } from "@/lib/prompts/closeTurn";

describe("toCerebrasJsonSchema", () => {
  it("strips minItems/maxItems on arrays", () => {
    const schema = z.object({ items: z.array(z.string()).min(2).max(4) });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/"minItems"/);
    expect(s).not.toMatch(/"maxItems"/);
  });

  it("strips pattern/minLength/maxLength on strings", () => {
    const schema = z.object({
      id: z
        .string()
        .regex(/^b\d+$/)
        .min(1)
        .max(50),
    });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/"pattern"/);
    expect(s).not.toMatch(/"minLength"/);
    expect(s).not.toMatch(/"maxLength"/);
  });

  it("strips minimum/maximum/format/$ref", () => {
    const schema = z.object({ n: z.int().positive() });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/"minimum"/);
    expect(s).not.toMatch(/"maximum"/);
    expect(s).not.toMatch(/"format"/);
    expect(s).not.toMatch(/"\$ref"/);
  });

  it("strips exclusiveMinimum/exclusiveMaximum", () => {
    // z.number().gt(5).lt(10) → exclusiveMinimum: 5, exclusiveMaximum: 10 in draft-7
    const schema = z.object({ n: z.number().gt(5).lt(10) });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/"exclusiveMinimum"/);
    expect(s).not.toMatch(/"exclusiveMaximum"/);
  });

  it("strips $schema from the root", () => {
    // z.toJSONSchema with target:"draft-7" emits $schema at the root;
    // Cerebras strict mode doesn't need it.
    const schema = z.object({ x: z.string() });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    expect(out.schema).not.toHaveProperty("$schema");
  });

  it("preserves description fields", () => {
    const schema = z.object({
      prompt: z.string().describe("[UI] question shown to learner"),
    });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    expect(JSON.stringify(out)).toMatch(/\[UI\] question shown to learner/);
  });

  it("throws when serialised size exceeds 5000 chars", () => {
    const huge = z.object({
      x: z.string().describe("a".repeat(6000)),
    });
    expect(() => toCerebrasJsonSchema(huge, { name: "t" })).toThrow(/exceeds.*5000/);
  });

  it("throws when schema object depth exceeds 10", () => {
    // 11 Zod nesting levels → 11 object-depth levels in JSON Schema.
    const deep = z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.object({
              e: z.object({
                f: z.object({
                  g: z.object({
                    h: z.object({
                      i: z.object({
                        j: z.object({
                          k: z.string(),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });
    expect(() => toCerebrasJsonSchema(deep, { name: "deep" })).toThrow(
      /depth \d+ exceeds Cerebras 10/,
    );
  });

  it("accepts schema at exactly 10 object-nesting levels", () => {
    // 10 Zod nesting levels — should NOT throw.
    const atLimit = z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.object({
              e: z.object({
                f: z.object({
                  g: z.object({
                    h: z.object({
                      i: z.object({
                        leaf: z.string(),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });
    expect(() => toCerebrasJsonSchema(atLimit, { name: "atLimit" })).not.toThrow();
  });

  it("handles discriminated-union-in-array-in-object (questionnaire-like pattern)", () => {
    // Mirrors the nested shape Task 2 will use: object > array > discriminated union > per-type payload.
    // Depth is shallow enough to pass the guard despite multiple nesting levels.
    const questionVariant = z.discriminatedUnion("type", [
      z.object({ type: z.literal("mc"), choices: z.array(z.string()) }),
      z.object({ type: z.literal("open"), hint: z.string() }),
    ]);
    const schema = z.object({
      questions: z.array(questionVariant),
    });
    // Should not throw — structural depth is only 3 (root > questions items > mc/open object).
    const out = toCerebrasJsonSchema(schema, { name: "questionnaire" });
    expect(out.name).toBe("questionnaire");
    // Cerebras strict mode rejects `oneOf`; a discriminated union must be
    // rewritten to the supported `anyOf` (its branches survive intact).
    const s = JSON.stringify(out);
    expect(s).toMatch(/choices|hint/);
    expect(s).not.toContain('"oneOf"');
    expect(s).toContain('"anyOf"');
  });

  it("flattens allOf from an intersection schema into a single object", () => {
    // `base.and(extra)` → z.intersection → z.toJSONSchema emits { allOf: [...] }.
    // Cerebras strict mode rejects allOf with a 400; the intersected object
    // schemas must be merged into one flat object.
    const schema = z.object({ a: z.string() }).and(z.object({ b: z.number() }));
    const out = toCerebrasJsonSchema(schema, { name: "intersection" });
    expect(JSON.stringify(out)).not.toContain('"allOf"');
    // Both branches' properties merge onto one object root.
    expect(out.schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(out.schema.properties).toHaveProperty("a");
    expect(out.schema.properties).toHaveProperty("b");
    // `required` is the union of both branches.
    expect(out.schema.required).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("attaches the supplied name", () => {
    const schema = z.object({ x: z.string() });
    const out = toCerebrasJsonSchema(schema, { name: "my_schema" });
    expect((out as { name?: string }).name).toBe("my_schema");
  });

  it("toSchemaJsonString returns pretty-printed body matching the cleaned schema", () => {
    const schema = z.object({ x: z.string().describe("[UI] greeting") });
    const wire = toCerebrasJsonSchema(schema, { name: "t" });
    const str = toSchemaJsonString(schema, { name: "t" });
    // Body matches the post-strip wire shape, byte-for-byte.
    expect(str).toBe(JSON.stringify(wire.schema, null, 2));
    // Pretty-printed (contains a newline + indentation).
    expect(str).toMatch(/\n {2}/);
    // Descriptions survive so the inlined block stays human-readable.
    expect(str).toContain("[UI] greeting");
    // Forbidden keywords are absent in the stringified output too.
    expect(str).not.toContain("$schema");
  });

  it("error message includes schema name and actual depth", () => {
    const deep = z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.object({
              e: z.object({
                f: z.object({
                  g: z.object({
                    h: z.object({
                      i: z.object({
                        j: z.object({ k: z.string() }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });
    expect(() => toCerebrasJsonSchema(deep, { name: "mySchema" })).toThrow(/mySchema/);
  });

  // --- Cerebras strict-mode validity over real production schemas ---
  // Guards against a schema construct that z.toJSONSchema would turn into
  // something Cerebras strict mode rejects with a 400: a dangling $ref, a
  // missing additionalProperties, a non-object root, a `oneOf` (Cerebras
  // supports `anyOf` only; `toCerebrasJsonSchema` rewrites `oneOf` to it),
  // or an `allOf` (from z.intersection — Cerebras rejects it outright;
  // `toCerebrasJsonSchema` flattens it into one merged object).

  /**
   * Recursively assert a JSON Schema node satisfies Cerebras strict mode:
   * no $ref / $defs / $anchor / oneOf / allOf anywhere, and every object
   * node declares `additionalProperties: false`.
   */
  function assertCerebrasStrictValid(node: unknown, path = "$"): void {
    if (Array.isArray(node)) {
      node.forEach((child, i) => assertCerebrasStrictValid(child, `${path}[${i}]`));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    for (const forbidden of ["$ref", "$defs", "$anchor", "oneOf", "allOf"]) {
      expect(
        obj,
        `${path}: "${forbidden}" is forbidden in Cerebras strict mode`,
      ).not.toHaveProperty(forbidden);
    }
    if (obj["type"] === "object") {
      expect(
        obj["additionalProperties"],
        `${path}: every object node needs additionalProperties:false`,
      ).toBe(false);
    }
    for (const [key, value] of Object.entries(obj)) {
      assertCerebrasStrictValid(value, `${path}.${key}`);
    }
  }

  // Minimal params for the close-turn schema factories. Only runtime values
  // (refine messages, allowed ids/names) depend on these — the JSON Schema
  // *shape* does not — so trivial fixtures suffice to exercise the guard.
  const closeParams: MakeCloseTurnBaseSchemaParams = {
    scopeTiers: [1, 2, 3],
    questionIds: ["q1"],
    freshConceptNames: ["c1"],
    reviewDueNames: [],
    existingConceptNames: ["c1"],
  };

  it.each<[string, z.ZodType<unknown>]>([
    ["clarify", clarifySchema],
    ["framework", frameworkSchema],
    ["wave_mid_turn", waveMidTurnSchema],
    // Close-turn schemas are `base.and(extra)` intersections — the exact
    // shape that emits `allOf`. They are the regression target here.
    ["wave_close", makeWaveCloseSchema(closeParams)],
    ["scoping_close", makeScopingCloseSchema(closeParams)],
  ])("produces a Cerebras-strict-valid schema for %s", (name, schema) => {
    const out = toCerebrasJsonSchema(schema, { name });
    // Cerebras strict mode requires an object at the root.
    expect(out.schema).toMatchObject({ type: "object" });
    assertCerebrasStrictValid(out.schema);
  });
});

describe("toOutputSchema", () => {
  const zodSchema = z.object({ x: z.string() }).refine((v) => v.x !== "bad", {
    message: "x must not be 'bad'",
  });

  it("exposes the same cleaned wire schema bytes as toCerebrasJsonSchema", async () => {
    const sdkSchema = toOutputSchema(zodSchema, { name: "test" });
    const wire = toCerebrasJsonSchema(zodSchema, { name: "test" });
    // `jsonSchema` exposes the wrapped JSON Schema via `.jsonSchema`.
    expect(await sdkSchema.jsonSchema).toEqual(wire.schema);
  });

  it("validates via Zod, surfacing refine failures", async () => {
    const sdkSchema = toOutputSchema(zodSchema, { name: "test" });
    const ok = await sdkSchema.validate!({ x: "fine" });
    expect(ok).toEqual({ success: true, value: { x: "fine" } });
    const bad = await sdkSchema.validate!({ x: "bad" });
    expect(bad.success).toBe(false);
    // The error must be the ZodError so issue messages reach retry directives.
    if (!bad.success) expect(bad.error.message).toContain("x must not be 'bad'");
  });
});

describe("toToolInputSchema", () => {
  const shape = z.object({
    name: z.string(),
    correct: z.enum(["A", "B", "C", "D"]).optional(),
    nested: z
      .object({
        rubric: z.string().optional(),
      })
      .optional(),
  });

  it("wire bytes are the bare-optional Cerebras-cleaned shape (no null unions)", async () => {
    const s = toToolInputSchema(shape, { name: "t" });
    const wire = JSON.stringify(await s.jsonSchema);
    // The anyOf-null union pattern must never reach the wire: it craters
    // tool-call reliability (docs/status/2026-07-06-tool-call-probe-verdict.md).
    expect(wire).not.toContain('"null"');
    expect(wire).not.toContain("anyOf");
  });

  it("validator absorbs explicit nulls on optional fields", async () => {
    const s = toToolInputSchema(shape, { name: "t" });
    const result = await s.validate!({ name: "x", correct: null, nested: { rubric: null } });
    expect(result).toEqual({ success: true, value: { name: "x", nested: {} } });
  });

  it("validator still rejects genuinely invalid input", async () => {
    const s = toToolInputSchema(shape, { name: "t" });
    const result = await s.validate!({ name: "x", correct: "E" });
    expect(result.success).toBe(false);
  });

  it("null-stripping does not touch nulls inside arrays' non-object items", async () => {
    const arrShape = z.object({ xs: z.array(z.string()) });
    const s = toToolInputSchema(arrShape, { name: "t" });
    // A null ARRAY ELEMENT is data, not an omitted field - it must still fail.
    const result = await s.validate!({ xs: ["a", null] });
    expect(result.success).toBe(false);
  });
});
