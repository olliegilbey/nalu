import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import functional from "eslint-plugin-functional";
import prettier from "eslint-config-prettier";

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
  // Disable ESLint rules that conflict with Prettier. Must be last.
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
