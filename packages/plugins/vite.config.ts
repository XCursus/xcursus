import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import {
  externalDependencies,
  noBundledDependencies,
} from "../../scripts/library.mjs";
// DOMPurify, marked, KaTeX and fflate stay dependencies; rich and media
// renderers are separate chunks that builtins import on demand.
export default defineConfig({
  plugins: [noBundledDependencies()],
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    lib: {
      entry: {
        archive: "src/archive.ts",
        sdk: "src/sdk/index.ts",
        rich: "src/rich.ts",
        media: "src/media.ts",
        navigation: "src/navigation.ts",
        sample: "src/sample.ts",
        builtins: "src/builtins.ts",
      },
      formats: ["es"],
      fileName: (_format, name) => name + ".js",
    },
    rollupOptions: {
      external: externalDependencies(
        fileURLToPath(new URL("./package.json", import.meta.url)),
      ),
    },
  },
});
