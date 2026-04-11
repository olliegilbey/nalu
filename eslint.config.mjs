import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import functional from "eslint-plugin-functional";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Immutable-first patterns: warn during MVP, don't block velocity
  {
    plugins: { functional },
    rules: {
      "functional/immutable-data": "warn",
      "functional/no-let": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
