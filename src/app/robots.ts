import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/config/site";

/**
 * `/robots.txt`. One `*` group welcomes every crawler, AI crawlers included,
 * to the public pages. A crawler with no group of its own follows `*`, so
 * naming GPTBot or ClaudeBot would only repeat it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // `/api/` is transport, not content. Once #249 lands, a cookieless call
      // there mints an anonymous account (#232).
      // `/course/` pages belong to one learner and render nothing public.
      disallow: ["/api/", "/course/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
