import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to this project directory. The repo nests
  // git worktrees under `.claude/worktrees/`, so multiple `bun.lock` files can
  // exist up the directory tree; without this pin, Turbopack infers the
  // outermost lockfile's directory as the root and builds the wrong project's
  // files. See:
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory
  turbopack: {
    root: import.meta.dirname,
  },
  // Reverse-proxy PostHog through our own origin so ad-blockers (which block
  // requests to *.posthog.com) don't drop analytics. The client SDK points at
  // `/api/_lib` (src/app/posthog-provider.tsx); these rewrites forward it to
  // PostHog EU ingestion + its asset CDN. `src/proxy.ts` already excludes
  // `/api`, so this path never mints an anonymous session.
  async rewrites() {
    return [
      {
        source: "/api/_lib/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/api/_lib/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
    ];
  },
  // PostHog's ingestion API uses trailing-slash paths; without this Next would
  // 308-redirect them and break capture.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
