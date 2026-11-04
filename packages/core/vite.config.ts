import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import {
  externalDependencies,
  noBundledDependencies,
} from "../../scripts/library.mjs";
// gl-matrix and the Ajv runtime helpers stay dependencies, never copied into dist.
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
        fileURLToPath(new URL("./package.json", import.meta.url)),
      ),
    },
  },
});
