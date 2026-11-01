import { defineConfig } from "vite";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: {
    alias: {
      // Listed before the package prefix, which would otherwise match.
      "@xcursus/plugins/style.css": new URL(
        "../../packages/plugins/src/katex.css",
        import.meta.url,
      ).pathname,
      "@xcursus/plugins": new URL("../../packages/plugins/src", import.meta.url)
        .pathname,
      "@xcursus/core": new URL(
        "../../packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
      // Listed before the package entry, which would otherwise match as a prefix.
      "@xcursus/player/fonts.css": new URL(
        "../../packages/player/src/fonts.css",
        import.meta.url,
      ).pathname,
      "@xcursus/player": new URL(
        "../../packages/player/src/browser.ts",
        import.meta.url,
      ).pathname,
    },
  },
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    assetsInlineLimit: 0,
  },
  server: { host: "127.0.0.1" },
});
