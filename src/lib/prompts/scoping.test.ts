import { describe, it, expect } from "vitest";
import { renderScopingSystem } from "./scoping";

describe("renderScopingSystem", () => {
  it("is byte-stable across calls", () => {
    const a = renderScopingSystem({ kind: "scoping", topic: "Rust ownership" });
    const b = renderScopingSystem({ kind: "scoping", topic: "Rust ownership" });
    expect(a).toBe(b);
  });

  it("includes the topic in <scoping_topic>", () => {
    expect(renderScopingSystem({ kind: "scoping", topic: "Hokusai" })).toContain(
      "<scoping_topic>Hokusai</scoping_topic>",
    );
  });
});
