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
    exclude: ["src/db/queries/**/*.test.ts", "src/db/**/*.integration.test.ts"],
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
