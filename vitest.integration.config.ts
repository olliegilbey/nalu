import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "integration",
    globals: true,
    environment: "node",
    include: ["src/db/**/*.integration.test.ts"],
    alias: { "@": path.resolve(__dirname, "./src") },
    // Testcontainers boots a Postgres per worker; serialise to one container.
    // poolOptions was removed in Vitest 4; fileParallelism:false sets maxWorkers=1.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ["src/db/testing/setup.ts"],
  },
});
