import { describe, expect, it } from "vitest";
import robots from "./robots";

/** The single rule group: `*` covers every crawler, AI crawlers included. */
function onlyRule() {
  const { rules } = robots();
  if (Array.isArray(rules)) throw new Error("expected one rule group for every crawler");
  return rules;
}

describe("robots", () => {
  it("welcomes every crawler to the public pages", () => {
    const rule = onlyRule();
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toBe("/");
  });

  it("disallows the API and the learner-private course pages", () => {
    // `/api/` is transport; after #249 a cookieless call mints an account.
    // `/course/` holds one learner's private course.
    expect(onlyRule().disallow).toEqual(["/api/", "/course/"]);
  });

  it("points crawlers at the production sitemap", () => {
    expect(robots().sitemap).toBe("https://nalu.ollie.gg/sitemap.xml");
  });
});
