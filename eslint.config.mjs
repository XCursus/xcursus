import js from "@eslint/js";
import ts from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
export default ts.config(
  {
    ignores: [
      "**/dist/**",
      ".tools/**",
      "**/validator.js",
      "test-results/**",
      "playwright-report/**",
      // Unmodified upstream impress.js files, test data only.
      "packages/impress-compat/test/fixtures/upstream/**",
    ],
  },
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        structuredClone: "readonly",
        performance: "readonly",
        AbortController: "readonly",
        document: "readonly",
        window: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        ResizeObserver: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: { "no-undef": "off" },
  },
);
