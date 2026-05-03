import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "integration",
    globals: true,
    environment: "node",
    include: ["src/db/**/*.integration.test.ts"],
    alias: { "@": path.resolve(__dirname, "./src") },
    // Testcontainers boots a Postgres per worker; serialise execution to a
    // single fork so all integration tests share one container.
    // Vitest 4 removed `poolOptions.forks.singleFork` — `fileParallelism: false`
    // is the supported equivalent (forces test files to run sequentially).
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ["src/db/testing/setup.ts"],
  },
});
