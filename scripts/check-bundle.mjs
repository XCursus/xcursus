import { build } from "vite";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
// Measurements go to the ignored test-results tree; no tracked file is rewritten.
const out = "test-results/bundle";
await rm(out, { recursive: true, force: true });
await build({
  configFile: false,
  logLevel: "error",
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    outDir: `${out}/consumer`,
    lib: {
      entry: "scripts/bundle-entry.ts",
      formats: ["es"],
      fileName: "consumer",
    },
    rollupOptions: {},
  },
});
let js = 0,
  css = 0;
const artifacts = [];
for (const name of await readdir(`${out}/consumer`)) {
  const data = await readFile(`${out}/consumer/${name}`);
  const size = gzipSync(data, { level: 9, mtime: 0 }).length;
  artifacts.push({ file: name, gzipBytes: size });
  if (name.endsWith(".js")) {
    js += size;
    if (
      /react-dom|react\/jsx|new Function|eval\(|@xcursus\/editor|DOMPurify|marked|KaTeX|fflate/.test(
        data.toString(),
      )
    )
      throw new Error("Forbidden dependency/dynamic compilation");
  }
  if (name.endsWith(".css")) {
    css += size;
    if (data.toString().includes("@font-face"))
      throw new Error("Theme fonts must stay out of the minimal player CSS");
  }
}
// Theme fonts are a separate, optional stylesheet with local files, loaded by
// the browser only when a document uses them: measured here, outside the CSS budget.
const fontsDir = "packages/player/dist/fonts";
const themeFonts = {
  cssGzipBytes: gzipSync(await readFile("packages/player/dist/fonts.css"), {
    level: 9,
    mtime: 0,
  }).length,
  files: [],
};
for (const name of (await readdir(fontsDir)).filter((n) =>
  n.endsWith(".woff2"),
))
  themeFonts.files.push({
    file: name,
    bytes: (await readFile(`${fontsDir}/${name}`)).length,
  });
themeFonts.totalBytes = themeFonts.files.reduce((n, f) => n + f.bytes, 0);
const result = {
  jsGzipBytes: js,
  cssGzipBytes: css,
  budgets: { js: 102400, css: 20480 },
  artifacts,
  themeFonts,
};
await mkdir(out, { recursive: true });
await writeFile(`${out}/report.json`, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
if (js > 102400 || css > 20480) throw new Error("Bundle budget exceeded");
