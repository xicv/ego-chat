const nodeGlobals = Object.fromEntries(
  [
    "AbortController",
    "Buffer",
    "cliLog",
    "URL",
    "URLSearchParams",
    "clearInterval",
    "clearTimeout",
    "console",
    "process",
    "click",
    "fillInput",
    "js",
    "listTabs",
    "openOrReuseTab",
    "pageInfo",
    "pressKey",
    "queueMicrotask",
    "setInterval",
    "setTimeout",
    "snapshotText",
    "structuredClone",
    "switchTab",
    "useOrCreateTaskSpace",
    "wait",
  ].map((name) => [name, "readonly"]),
)

export default [
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: nodeGlobals,
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "eqeqeq": ["error", "always"],
      "no-console": "off",
      "no-constant-condition": ["error", { "checkLoops": false }],
      "no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",
        "caughtErrors": "all",
        "caughtErrorsIgnorePattern": "^_"
      }],
      "no-undef": "error",
      "prefer-const": "error"
    },
  },
]
