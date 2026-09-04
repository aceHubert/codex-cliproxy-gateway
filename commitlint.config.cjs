module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "conflict",
        "delete",
        "docs",
        "feat",
        "fix",
        "font",
        "perf",
        "refactor",
        "revert",
        "stash",
        "style",
        "test",
      ],
    ],
  },
};
