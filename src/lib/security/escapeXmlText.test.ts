import { describe, it, expect } from "vitest";
import { escapeXmlText } from "./escapeXmlText";

describe("escapeXmlText", () => {
  // Encoding `&` last would let `<` → `&lt;` get re-encoded to `&amp;lt;` and a
  // single decode pass would resurrect `<`. Encoding `&` first is the only
  // order that survives a single decode pass cleanly.
  it("encodes ampersand first to prevent double-decode resurrection", () => {
    expect(escapeXmlText("a & <b> c")).toBe("a &amp; &lt;b&gt; c");
  });

  it("returns empty string unchanged", () => {
    expect(escapeXmlText("")).toBe("");
  });

  it("does not wrap output (caller controls envelope)", () => {
    expect(escapeXmlText("plain")).toBe("plain");
  });

  it("encodes every angle bracket and ampersand, nothing else", () => {
    // Multi-occurrence input — proves we replace all instances, not just the
    // first match. The earlier "ampersand first" test only covers one of each.
    expect(escapeXmlText("&& <<x>>")).toBe("&amp;&amp; &lt;&lt;x&gt;&gt;");
    expect(escapeXmlText("'\"unicode→arrow")).toBe("'\"unicode→arrow");
  });
});
