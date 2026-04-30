import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "unit",
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [
      // DB query tests all require a live Postgres connection — skip in unit project.
      "src/db/queries/**/*.test.ts",
      // Integration tests (.integration.test.ts) run under the integration project only.
      "src/db/**/*.integration.test.ts",
    ],
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
