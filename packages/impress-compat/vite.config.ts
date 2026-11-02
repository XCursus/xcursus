import { defineConfig } from "vite";
import {
  externalDependencies,
  noBundledDependencies,
} from "../../scripts/library.mjs";
// parse5, gl-matrix and the core stay dependencies, never copied into dist.
export default defineConfig({
  plugins: [noBundledDependencies()],
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: externalDependencies(
        new URL("./package.json", import.meta.url).pathname,
      ),
    },
  },
});
