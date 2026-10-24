import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/config/site";

/**
 * `/sitemap.xml`. Public pages only. Course and Wave pages belong to one
 * learner, so they stay out, as `robots.ts` disallows them. No `lastModified`:
 * a build-time date would claim a change that never happened.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/` }];
}
