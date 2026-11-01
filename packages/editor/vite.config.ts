import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  externalDependencies,
  noBundledDependencies,
} from "../../scripts/library.mjs";
// React (peer), core, player and plugins stay external, subpaths included.
// The player stylesheet is bundled into editor.css, as before 0.6.
const external = externalDependencies(
  new URL("./package.json", import.meta.url).pathname,
);
export default defineConfig({
  plugins: [react(), noBundledDependencies()],
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    lib: {
      entry: "src/browser.ts",
      formats: ["es"],
      fileName: "index",
      cssFileName: "editor",
    },
    rollupOptions: {
      external: (id) => id !== "@xcursus/player/style.css" && external(id),
    },
  },
});
