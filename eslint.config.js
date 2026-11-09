import importX from "eslint-plugin-import-x";
import perfectionist from "eslint-plugin-perfectionist";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "import-x": importX,
      perfectionist,
    },
    rules: {
      "import-x/no-duplicates": ["error", { "prefer-inline": true }],
      "perfectionist/sort-imports": ["error", {
        groups: ["side-effect", "builtin", "external", ["parent", "sibling", "index"], "unknown", { group: "type", type: "unsorted" }],
        newlinesBetween: 0,
      }],
      "perfectionist/sort-named-imports": ["error",
        { useConfigurationIf: { matchesAstSelector: 'ImportDeclaration[importKind="type"]' }, type: "unsorted" },
        { groups: ["value-import", { group: "type-import", type: "unsorted" }] },
      ],
    },
  },
];
