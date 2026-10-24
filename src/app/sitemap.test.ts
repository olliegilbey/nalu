import { describe, expect, it } from "vitest";
import sitemap from "./sitemap";

describe("sitemap", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("lists the home page, the only public page", () => {
    expect(urls).toEqual(["https://nalu-phi.vercel.app/"]);
  });

  it("lists no learner-private course page and no API route", () => {
    for (const url of urls) {
      expect(url).not.toContain("/course/");
      expect(url).not.toContain("/api/");
    }
  });
});
