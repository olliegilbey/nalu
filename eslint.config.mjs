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
  // Global hardening. Keep tight; per-file overrides below relax where needed.
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "max-lines": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  // Algorithm files: no magic numbers. All tunables must live in
  // src/lib/config/tuning.ts. Small values that are indices / the SM-2
  // quality-score domain are allowed so we don't drown in false positives.
  {
    files: ["src/lib/scoring/**/*.ts", "src/lib/spaced-repetition/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-magic-numbers": [
        "error",
        {
          ignore: [0, 1, -1, 2, 3, 4, 5],
          ignoreArrayIndexes: true,
          enforceConst: true,
        },
      ],
    },
  },
  // Live smoke tests: console.log is intentional — output is the manual eyeball check.
  {
    files: ["**/*.live.test.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // Test files: allow any length; ban committed .only.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "max-lines": "off",
      // Catch .only anywhere in the member chain: it.only(), describe.only(),
      // test.only(), it.only.each(), test.concurrent.only(), etc.
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='only'][object.name=/^(it|describe|test)$/]",
          message: "Remove .only before committing",
        },
        {
          selector:
            "MemberExpression[property.name='only'][object.object.name=/^(it|describe|test)$/]",
          message: "Remove .only before committing",
        },
      ],
    },
  },
  // Disable ESLint rules that conflict with Prettier. Must be last.
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
