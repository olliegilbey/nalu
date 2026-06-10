import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsdoc from "eslint-plugin-jsdoc";
import prettier from "eslint-config-prettier";

// Lint is split into two tiers:
//
//   ERROR — silent/expensive defects the agent must fix before commit.
//     Examples: stray console.log, committed .only, secrets-adjacent.
//
//   WARN  — recall-trigger backstops. Cheap to fix; lets the agent ship
//           without ceremony when there's a genuine exception. These
//           codify rules from AGENTS.md so prose and lint stay aligned.
//
// Conventions that belong to human/agent judgment (file length, naming,
// abstraction timing, functional style) live only in AGENTS.md.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Type-aware rules need access to the project. Scoped to src/**/*.ts(x)
  // so root config files aren't dragged into the tsconfig graph.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: true,
      },
    },
    rules: {
      // Forgotten awaits / fire-and-forget without `void`. Real bug class
      // in an async-heavy codebase. Use `void promise` to mark intent.
      "@typescript-eslint/no-floating-promises": "warn",
      // Backstop for "No `any`" in AGENTS.md.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Global hardening: stray console.log in prod paths is a real bug class.
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },

  // Architectural boundaries (warn). Codifies AGENTS.md:
  //   - LLM SDKs only in src/lib/llm/
  //   - Drizzle / raw DB clients only in src/db/
  // Overrides below relax these in the allowed directories.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["ai", "ai/*", "@ai-sdk/*"],
              message: "LLM SDK imports belong in src/lib/llm/ (see AGENTS.md).",
              // Type-only imports don't cross the runtime boundary; the
              // `src/lib/types/llm.ts` re-export layer relies on this.
              allowTypeImports: true,
            },
            {
              group: ["drizzle-orm", "drizzle-orm/*", "postgres", "pg"],
              message: "DB clients belong in src/db/ (see AGENTS.md).",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // Narrow exemption: only `provider.ts` and `generate.ts` need runtime
  // `ai`/`@ai-sdk` imports (per AGENTS.md). Other files in `src/lib/llm/`
  // (e.g. `toCerebrasJsonSchema.ts`) get type-only access via the
  // `allowTypeImports: true` escape hatch — same as the rest of the repo.
  {
    files: ["src/lib/llm/provider.ts", "src/lib/llm/generate.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["src/db/**/*.ts", "src/db/**/*.tsx"],
    rules: { "no-restricted-imports": "off" },
  },
  // Test files + test infrastructure: bypass the architectural import
  // restriction. Tests legitimately reach into DB internals and stub LLM
  // boundaries for fixture setup.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "src/lib/testing/**/*.ts", "src/lib/testing/**/*.tsx"],
    rules: { "no-restricted-imports": "off" },
  },

  // Magic numbers in algorithm files (warn). All tunables must live in
  // src/lib/config/tuning.ts. Small ints (indices, SM-2 quality domain)
  // are ignored to avoid false-positive drowning.
  {
    files: ["src/lib/scoring/**/*.ts", "src/lib/spaced-repetition/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-magic-numbers": [
        "warn",
        {
          ignore: [0, 1, -1, 2, 3, 4, 5],
          ignoreArrayIndexes: true,
          enforceConst: true,
        },
      ],
    },
  },

  // TSDoc on every exported declaration (warn). Recall trigger for the
  // "TSDoc on every export" rule in AGENTS.md. Tests exempt.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    plugins: { jsdoc },
    rules: {
      "jsdoc/require-jsdoc": [
        "warn",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration"],
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
  // Override default ignores of eslint-config-next. Use `**/` prefix so
  // nested checkouts (e.g. agent worktrees) are also skipped — unprefixed
  // globs anchor at the config root and miss those.
  // `.claude/worktrees/**` is ignored wholesale: worktrees are agent-tooling
  // checkouts that may sit on older branches with stale lint config.
  globalIgnores([
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "next-env.d.ts",
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
