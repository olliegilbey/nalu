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
};

export default nextConfig;
