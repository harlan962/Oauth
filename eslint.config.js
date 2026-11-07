import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Deliberately close to the current codebase: the goal is to catch real
// mistakes (unreachable code, unused bindings, accidental globals, == vs ===)
// without turning every stylistic preference into a CI failure. Tighten rules
// one at a time, not all at once.
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "output/**",
      ".local-browsers/**",
      ".superpowers/**",
      "deploy/**",
      "*.config.js",
    ],
  },
  js.configs.recommended,
  // TypeScript rules apply to TypeScript only; running them over plain .js in
  // server/ and tests/ duplicates the core rules with different semantics.
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["server/**/*.js", "scripts/**/*.mjs", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Empty catch blocks are intentional here: a failing cleanup or a probe
      // that is allowed to fail should not mask the real error path.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        { args: "none", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      // These files sanitise strings that legitimately contain control bytes.
      "no-control-regex": "off",
      "no-console": "off",
    },
  },
  {
    // page.evaluate callbacks execute inside Chromium, so browser globals are
    // correct here even though the file itself runs under Node.
    files: [
      "server/oauth-browser.js",
      "server/pat-browser.js",
      "server/pat-form.js",
      "scripts/diagnose-workbuddy-*.mjs",
      "tests/*-browser.test.js",
      "tests/pat-2fa.test.js",
      "tests/pat-github-form.test.js",
      "tests/ui.test.js",
    ],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      // TypeScript already resolves identifiers; no-undef only produces false
      // positives for JSX and type-only names.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "none", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
