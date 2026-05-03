import { defineConfig } from "vitest/config";

/**
 * Top-level Vitest config. Vitest 4 removed `vitest.workspace.ts`;
 * projects now live in `test.projects`. Each project file owns its
 * own environment, includes/excludes, and pool settings.
 */
export default defineConfig({
  test: {
    projects: ["./vitest.unit.config.ts", "./vitest.integration.config.ts"],
  },
});
