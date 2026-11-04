import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      // Listed before the package prefix, which would otherwise match.
      "@xcursus/plugins/style.css": fileURLToPath(
        new URL("../../packages/plugins/src/katex.css", import.meta.url),
      ),
      "@xcursus/plugins": fileURLToPath(
        new URL("../../packages/plugins/src", import.meta.url),
      ),
      "@xcursus/core": fileURLToPath(
        new URL("../../packages/core/src/index.ts", import.meta.url),
      ),
      // Listed before the package entry, which would otherwise match as a prefix.
      "@xcursus/player/fonts.css": fileURLToPath(
        new URL("../../packages/player/src/fonts.css", import.meta.url),
      ),
      "@xcursus/player": fileURLToPath(
        new URL("../../packages/player/src/browser.ts", import.meta.url),
      ),
    },
  },
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    assetsInlineLimit: 0,
  },
  server: { host: "127.0.0.1" },
});
