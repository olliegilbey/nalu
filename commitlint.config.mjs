// Conventional Commits, restricted to the types we actually use.
// Mirrors the global prefs in ~/.claude/CLAUDE.md.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "chore", "docs", "refactor", "test", "perf", "style", "ci"],
    ],
  },
};
