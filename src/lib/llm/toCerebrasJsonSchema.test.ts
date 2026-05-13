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

  it("throws when depth exceeds 10", () => {
    // Build 11-deep nested object.
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
    expect(() => toCerebrasJsonSchema(deep, { name: "t" })).toThrow(/depth/);
  });

  it("attaches the supplied name", () => {
    const schema = z.object({ x: z.string() });
    const out = toCerebrasJsonSchema(schema, { name: "my_schema" });
    expect((out as { name?: string }).name).toBe("my_schema");
  });
});
