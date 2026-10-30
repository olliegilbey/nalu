/**
 * Production origin, with no trailing slash. Page metadata (`metadataBase`),
 * `robots.txt` and `sitemap.xml` build their absolute URLs from it.
 * `public/llms.txt` is static, so it repeats the origin; `src/app/llms.test.ts`
 * keeps the two in step.
 *
 * A constant, not an env var: preview deploys should still point crawlers and
 * link unfurlers at production.
 */
export const SITE_URL = "https://nalu.ollie.gg";
