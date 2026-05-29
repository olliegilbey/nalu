import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

// Lint enforces only what's expensive to miss. Style/convention guidance
// (file length, magic numbers, immutability, TSDoc) lives in AGENTS.md as
// prose, not as rules — see "Conventions" there.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Global hardening: stray console.log in prod paths is a real bug class.
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  // Live smoke tests: console.log is intentional — output is the manual eyeball check.
  {
    files: ["**/*.live.test.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // Test files: ban committed .only — silently skips other tests.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
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
