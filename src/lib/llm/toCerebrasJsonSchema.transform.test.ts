import { describe, expect, it } from "vitest";
import { flattenAllOf } from "./toCerebrasJsonSchema.transform";

/**
 * Direct unit tests for the `flattenAllOf` fail-fast guards. The public-API
 * integration tests in `toCerebrasJsonSchema.test.ts` exercise the happy path
 * via real production schemas; this file pins the *guard* behaviour so a
 * future intersection shape that breaks the assumptions fails loud at build
 * time instead of silently weakening the wire schema. Regression target:
 * CodeRabbit's "fail fast for unsupported or overlapping allOf members"
 * thread on PR #24.
 */
describe("flattenAllOf — fail-fast guards", () => {
  it("throws when an allOf member is not an object schema", () => {
    // Nalu's `z.intersection`-of-`z.object` pattern guarantees every member
    // is `{ type: "object", properties: …, required: … }`. Any other shape
    // (string, array, missing type) has no defensible flatten semantics —
    // merging would silently weaken the wire schema. Refuse to flatten.
    const node = {
      allOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "string" }, // not an object schema
      ],
    };
    expect(() => flattenAllOf(node)).toThrow(/object schema|non-object/i);
  });

  it("throws when two allOf members share a property name", () => {
    // Disjoint properties is the documented invariant. A duplicate key means
    // one branch's definition silently overwrites the other; the loud throw
    // forces the caller to reconcile the schemas explicitly.
    const node = {
      allOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { a: { type: "number" } } },
      ],
    };
    expect(() => flattenAllOf(node)).toThrow(/duplicate.*['"`]?a['"`]?/i);
  });

  it("still merges disjoint object members cleanly (happy-path regression)", () => {
    const node = {
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    };
    const out = flattenAllOf(node);
    expect(out).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" }, b: { type: "number" } },
    });
    expect(out["required"]).toEqual(expect.arrayContaining(["a", "b"]));
  });
});
