import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { toCerebrasJsonSchema } from "./toCerebrasJsonSchema";

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
    // Discriminated unions emit anyOf/oneOf — ensure they survived stripping.
    const s = JSON.stringify(out);
    expect(s).toMatch(/choices|hint/);
  });

  it("attaches the supplied name", () => {
    const schema = z.object({ x: z.string() });
    const out = toCerebrasJsonSchema(schema, { name: "my_schema" });
    expect((out as { name?: string }).name).toBe("my_schema");
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
});
