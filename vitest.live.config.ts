import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest project config for live smoke tests.
 *
 * WHY a separate project: live tests call real Cerebras and a real testcontainers
 * Postgres. They are too slow and cost-bearing for CI or `just check`. Gated
 * behind `CEREBRAS_LIVE=1` at the describe level too, but a dedicated project
 * keeps them off the default run entirely.
 *
 * `fileParallelism: false`: sequential file execution so we don't hammer the
 * Cerebras free-tier rate limit with concurrent long-running tests.
 * `testTimeout: 180_000`: each test makes 3–4 LLM round-trips; framework gen
 * alone can take 10–30s on Cerebras free tier, and the close-turn test in
 * submitBaseline.live makes 4 round-trips including a slower qwen call. 120s
 * was right at the edge; 180s gives comfortable headroom without masking a
 * genuine hang.
 */
export default defineConfig({
  test: {
    name: "live",
    globals: true,
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    alias: { "@": path.resolve(__dirname, "./src") },
    pool: "forks",
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    setupFiles: ["src/db/testing/setup.ts"],
  },
});
