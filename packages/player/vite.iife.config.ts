import { defineConfig } from "vite";
import { licenseBanner, licenseNotices } from "../../scripts/library.mjs";
const { version } = (await import("./package.json", { with: { type: "json" } }))
  .default;
// Classic-script build of the same player for pages without a bundler. It
// embeds core, gl-matrix and the Ajv runtime helpers, so it carries the GPL
// notice and a generated third-party notice file next to it.
export default defineConfig({
  plugins: [
    licenseBanner(
      `/*! XCursus player ${version} | GPL-3.0-or-later | source: https://github.com/XCursus/xcursus | bundled third-party code: THIRD_PARTY_NOTICES.txt */`,
    ),
    licenseNotices({
      fileName: "THIRD_PARTY_NOTICES.txt",
      title: `XCursus player ${version}, IIFE build (xcursus-player.iife.js)`,
    }),
  ],
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    outDir: "dist/iife",
    emptyOutDir: true,
    lib: {
      entry: "src/iife.ts",
      formats: ["iife"],
      name: "XCursus",
      fileName: () => "xcursus-player.iife.js",
      cssFileName: "player",
    },
  },
});
