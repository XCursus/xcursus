import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "@xcursus/core": new URL("./packages/core/src/index.ts", import.meta.url)
        .pathname,
      "@xcursus/player": new URL(
        "./packages/player/src/index.ts",
        import.meta.url,
      ).pathname,
      "@xcursus/plugins/archive": new URL(
        "./packages/plugins/src/archive.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "packages/core/src/**/*.ts",
        "packages/player/src/**/*.ts",
        "packages/plugins/src/{security,archive,media}.ts",
        "packages/editor/src/{store,storage}/**/*.ts",
      ],
      exclude: [
        "packages/core/src/document/types.ts",
        "packages/core/src/document/validator.d.ts",
        "packages/*/src/env.d.ts",
        "packages/player/src/browser.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "test-results/coverage",
      // Per-area floors a few points under the measured coverage. Uncovered
      // branches are mostly DOM, focus and IndexedDB engine paths exercised by
      // the browser E2E suite instead; see docs/VERIFICATION.md#coverage.
      thresholds: {
        "packages/core/src/**": { statements: 85, branches: 80 },
        "packages/player/src/assets/**": { statements: 90, branches: 85 },
        "packages/player/src/{index,content/index,messages}.ts": {
          statements: 80,
          branches: 65,
        },
        "packages/plugins/src/{security,archive,media}.ts": {
          statements: 85,
          branches: 75,
        },
        "packages/editor/src/{store,storage}/**": {
          statements: 88,
          branches: 72,
        },
      },
    },
  },
});
