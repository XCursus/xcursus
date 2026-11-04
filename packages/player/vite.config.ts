import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import {
  externalDependencies,
  noBundledDependencies,
} from "../../scripts/library.mjs";
export default defineConfig({
  plugins: [noBundledDependencies()],
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    lib: {
      entry: { index: "src/browser.ts", presenter: "src/presenter.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: "player",
    },
    rollupOptions: {
      external: externalDependencies(
        fileURLToPath(new URL("./package.json", import.meta.url)),
      ),
    },
  },
});
