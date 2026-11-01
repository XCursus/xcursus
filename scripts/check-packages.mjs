import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { installedPackage } from "./library.mjs";
import { gzipSync } from "node:zlib";
// 0.6 packaging gate: the tarballs of `pnpm pack`, installed in a consumer
// outside the workspace (no source aliases), type-check without skipLibCheck,
// build a minimal and a realistic consumer and keep third-party code external.
// Everything is written under the ignored test-results/packages tree; the E2E
// suite serves the consumer build and runs the CLI installed from its tarball.
const root = new URL("..", import.meta.url).pathname;
const out = join(root, "test-results", "packages");
const tarballs = join(out, "tarballs");
const consumer = join(out, "consumer");
const names = ["core", "player", "plugins", "editor", "cli"];
const run = (command, args, cwd, env = {}) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
await rm(out, { recursive: true, force: true });
await mkdir(tarballs, { recursive: true });
const report = { packages: [], consumer: {}, checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) console.error(`FAIL ${name}`, detail ?? "");
};

// 1. Pack every library and inspect the tarball contents.
const manifests = {};
for (const name of names) {
  const dir = join(root, "packages", name);
  const manifest = JSON.parse(
    await readFile(join(dir, "package.json"), "utf8"),
  );
  manifests[name] = manifest;
  run("pnpm", ["pack", "--pack-destination", tarballs], dir);
  const file = `xcursus-${name}-${manifest.version}.tgz`;
  const listing = run("tar", ["tzf", join(tarballs, file)], root)
    .split("\n")
    .filter(Boolean);
  const packed = JSON.parse(
    run(
      "tar",
      ["xzf", join(tarballs, file), "-O", "package/package.json"],
      root,
    ),
  );
  const size = (await stat(join(tarballs, file))).size;
  report.packages.push({
    name: manifest.name,
    file,
    bytes: size,
    files: listing.length,
  });
  for (const field of [
    "license",
    "description",
    "repository",
    "homepage",
    "keywords",
    "sideEffects",
    "engines",
  ])
    check(`${name}: manifest ${field}`, packed[field] !== undefined);
  check(
    `${name}: license GPL-3.0-or-later`,
    packed.license === "GPL-3.0-or-later",
  );
  check(
    `${name}: README and LICENSE packed`,
    listing.includes("package/README.md") &&
      listing.includes("package/LICENSE"),
  );
  check(
    `${name}: internal dependencies pinned to the same version`,
    Object.entries(packed.dependencies ?? {})
      .filter(([dep]) => dep.startsWith("@xcursus/"))
      .every(([, range]) => range === manifest.version),
  );
  if (name === "editor")
    check(
      "editor: React peers are ranges",
      /^\^/.test(packed.peerDependencies.react) &&
        /^\^/.test(packed.peerDependencies["react-dom"]),
    );
}

// 2. Library dists import their third-party dependencies instead of copying them.
const external = {
  core: ["gl-matrix", "ajv/dist/runtime/"],
  plugins: ["dompurify", "marked", "katex", "fflate"],
};
for (const [name, specifiers] of Object.entries(external)) {
  const dist = join(root, "packages", name, "dist");
  const files = (await readdir(dist)).filter((f) => f.endsWith(".js"));
  const code = (
    await Promise.all(files.map((f) => readFile(join(dist, f), "utf8")))
  ).join("\n");
  for (const specifier of specifiers)
    check(
      `${name}: imports ${specifier} as a dependency`,
      code.includes(`from "${specifier}`) ||
        code.includes(`from '${specifier}`),
    );
  check(
    `${name}: no inlined font data`,
    !/data:font|data:application\/font/.test(code),
  );
}
for (const [name, notices] of [
  ["player", "packages/player/dist/iife/THIRD_PARTY_NOTICES.txt"],
  ["cli", "packages/cli/dist/runtime/THIRD_PARTY_NOTICES.txt"],
]) {
  const text = await readFile(join(root, notices), "utf8");
  check(
    `${name}: notices start with the GPL notice and the source`,
    text.includes("GPL-3.0-or-later") &&
      text.includes("https://github.com/XCursus/xcursus"),
  );
  const expected =
    name === "player"
      ? ["ajv", "fast-deep-equal", "gl-matrix"]
      : [
          "ajv",
          "dompurify",
          "fast-deep-equal",
          "gl-matrix",
          "katex",
          "marked",
          "@fontsource/atkinson-hyperlegible",
        ];
  for (const pkg of expected)
    check(
      `${name}: notices include ${pkg}`,
      new RegExp(`^${pkg.replace("/", "\\/")} \\S+\\nLicense: `, "m").test(
        text,
      ),
    );
}

// 3. External consumer: tarballs only, installed from the local store without network.
await mkdir(join(consumer, "src"), { recursive: true });
const tgz = (name) =>
  `file:../tarballs/xcursus-${name}-${manifests[name].version}.tgz`;
const rootManifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "xcursus-tarball-consumer",
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        names.map((n) => [`@xcursus/${n}`, tgz(n)]),
      ),
      devDependencies: {
        typescript: rootManifest.devDependencies.typescript,
        vite: rootManifest.devDependencies.vite,
        react: "19.3.1",
        "react-dom": "19.3.1",
        "@types/react": rootManifest.devDependencies["@types/react"],
        // The CLI API is a Node API.
        "@types/node": rootManifest.devDependencies["@types/node"],
      },
    },
    null,
    2,
  ),
);
// Its own pnpm-workspace.yaml makes the consumer a separate root (the
// repository workspace is not inherited), maps internal dependencies of the
// tarballs to the other tarballs and pins the third-party runtime dependencies
// to the versions of the repository lockfile, so the consumer resolves the
// same code wherever the registry metadata come from.
const pinned = Object.fromEntries(
  [
    ["core", ["gl-matrix", "ajv"]],
    ["plugins", ["dompurify", "marked", "katex", "fflate"]],
    ["cli", ["playwright-core", "pdf-lib"]],
    ["player", ["@fontsource/atkinson-hyperlegible"]],
  ].flatMap(([pkg, deps]) =>
    deps.map((dep) => [
      dep,
      JSON.parse(
        readFileSync(
          join(
            installedPackage(dep, join(root, "packages", pkg)),
            "package.json",
          ),
          "utf8",
        ),
      ).version,
    ]),
  ),
);
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const releaseAge =
  /minimumReleaseAgeExclude:\n(?:\s+- .+\n?)+/.exec(workspace)?.[0] ?? "";
report.consumer.pinned = pinned;
await writeFile(
  join(consumer, "pnpm-workspace.yaml"),
  `strictPeerDependencies: true\n${releaseAge.trimEnd()}\noverrides:\n${[
    ...names.map((n) => `  "@xcursus/${n}": "${tgz(n)}"`),
    ...Object.entries(pinned).map(
      ([dep, version]) => `  "${dep}": "${version}"`,
    ),
  ].join("\n")}\n`,
);
const examples = join(root, "examples");
await copyFile(
  join(examples, "content-gallery/content-gallery.xcursus"),
  join(consumer, "src/gallery.xcursus"),
);
await copyFile(
  join(examples, "layout-canvas/project.json"),
  join(consumer, "src/layout.json"),
);
await writeFile(
  join(consumer, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      resolveJsonModule: true,
      jsx: "react-jsx",
      types: ["node"],
    },
    include: ["src"],
  }),
);
await writeFile(
  join(consumer, "src/env.d.ts"),
  'declare module "*.css";\ndeclare module "*?url" { const url: string; export default url; }\n',
);
// Minimal consumer: core + player only, two players and destroy.
await writeFile(
  join(consumer, "minimal.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Minimal consumer</title></head><body><main><div id="a" style="height:360px"></div><div id="b" style="height:360px"></div><button id="destroy">Destroy</button></main><script type="module" src="./src/minimal.ts"></script></body></html>\n',
);
await writeFile(
  join(consumer, "src/minimal.ts"),
  `import { createPlayer } from "@xcursus/player";
import type { Player } from "@xcursus/player";
import "@xcursus/player/style.css";
import "@xcursus/player/fonts.css";
import project from "./layout.json";
const players: Player[] = [createPlayer(), createPlayer()];
const results = await Promise.all(
  players.map((p, i) => p.mount(document.getElementById(i ? "b" : "a")!, project)),
);
document.getElementById("destroy")!.onclick = () => players.forEach((p) => p.destroy());
Object.assign(window, { consumer: { players, results: results.map((r) => r.ok) } });
`,
);
// Realistic consumer: rich renderers on demand, media, archive reading, KaTeX and theme fonts.
await writeFile(
  join(consumer, "realistic.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Realistic consumer</title></head><body><main><div id="deck" style="height:600px"></div></main><script type="module" src="./src/realistic.ts"></script></body></html>\n',
);
await writeFile(
  join(consumer, "src/realistic.ts"),
  `import { createAssetResolver, createPlayer } from "@xcursus/player";
import { createBuiltinRegistry } from "@xcursus/plugins/builtins";
import { readArchive } from "@xcursus/plugins/archive";
import "@xcursus/player/style.css";
import "@xcursus/player/fonts.css";
import "@xcursus/plugins/style.css";
import archive from "./gallery.xcursus?url";
const { document: project, blobs } = await readArchive(await (await fetch(archive)).blob());
const { registry } = createBuiltinRegistry();
const player = createPlayer({ registry, assets: createAssetResolver(project.assets, blobs) });
const result = await player.mount(document.getElementById("deck")!, project);
Object.assign(window, { consumer: { player, ok: result.ok } });
`,
);
// Type surface of every package, including the editor and the CLI API.
await writeFile(
  join(consumer, "src/types.ts"),
  `import { validateDocument, planCapture, sampleCapture, publicDocument } from "@xcursus/core";
import type { CapturePlan, ProjectDocument, Itinerary } from "@xcursus/core";
import { createPlayer, italianMessages, defaultMessages } from "@xcursus/player";
import type { Player, PlayerOptions, ContentRenderer } from "@xcursus/player";
import { createBuiltinRegistry, lazyRenderer } from "@xcursus/plugins/builtins";
import { writeArchive } from "@xcursus/plugins/archive";
import { PluginHost } from "@xcursus/plugins";
import { samplePlugin } from "@xcursus/plugins/sample";
import { Studio, EditorStore, emptyProject, RecoveryRepository } from "@xcursus/editor";
import type { StudioProps, DocumentEdit } from "@xcursus/editor";
import { run, EXIT } from "@xcursus/cli";
import type { ExportManifest } from "@xcursus/cli";
export const surface = { validateDocument, planCapture, sampleCapture, publicDocument, createPlayer, italianMessages, defaultMessages, createBuiltinRegistry, lazyRenderer, writeArchive, PluginHost, samplePlugin, Studio, EditorStore, emptyProject, RecoveryRepository, run, EXIT };
export type Surface = [CapturePlan, ProjectDocument, Itinerary, Player, PlayerOptions, ContentRenderer, StudioProps, DocumentEdit, ExportManifest];
const options: PlayerOptions = { messages: italianMessages, controls: false };
export const player: Player = createPlayer(options);
export const store = new EditorStore(emptyProject());
`,
);
await writeFile(
  join(consumer, "vite.config.mjs"),
  `import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    manifest: true,
    rollupOptions: { input: { minimal: "minimal.html", realistic: "realistic.html" } },
  },
});
`,
);
// Packages come from the local store when present; registry metadata are
// fetched only if the cache lacks them (a fresh CI runner after a frozen install).
run("pnpm", ["install", "--prefer-offline"], consumer);
const bin = (name) => join(consumer, "node_modules", ".bin", name);
let typecheck = "";
try {
  typecheck = run(bin("tsc"), ["-p", "."], consumer);
  check("consumer: tsc without skipLibCheck", true);
} catch (error) {
  check(
    "consumer: tsc without skipLibCheck",
    false,
    String(error.stdout ?? error),
  );
}
report.consumer.typecheck = typecheck.trim() || "no diagnostics";
run(bin("vite"), ["build", "--logLevel", "error"], consumer);
check(
  "consumer: CLI from tarball runs",
  run(bin("xcursus"), ["--version"], consumer).trim() === manifests.cli.version,
);

// 4. Budgets measured on the built consumers (gzip level 9).
const dist = join(consumer, "dist");
const vm = JSON.parse(
  await readFile(join(dist, ".vite/manifest.json"), "utf8"),
);
const gz = async (file) =>
  gzipSync(await readFile(join(dist, file)), { level: 9, mtime: 0 }).length;
async function closure(key, follow) {
  const seen = new Set(),
    files = new Set(),
    css = new Set(),
    assets = new Set();
  const visit = (k) => {
    if (seen.has(k)) return;
    seen.add(k);
    const entry = vm[k];
    files.add(entry.file);
    for (const c of entry.css ?? []) css.add(c);
    for (const a of entry.assets ?? []) assets.add(a);
    for (const i of entry.imports ?? []) visit(i);
    if (follow) for (const i of entry.dynamicImports ?? []) visit(i);
  };
  visit(key);
  const sum = async (set) =>
    (await Promise.all([...set].map(gz))).reduce((a, b) => a + b, 0);
  return {
    jsGzip: await sum(files),
    cssGzip: await sum(css),
    js: [...files],
    css: [...css],
    assets: [...assets],
  };
}
const minimal = await closure("minimal.html", false);
const initial = await closure("realistic.html", false);
const full = await closure("realistic.html", true);
const fonts = (await readdir(join(dist, "assets"))).filter((f) =>
  /\.(woff2?|ttf|otf)$/.test(f),
);
const fontBytes = (
  await Promise.all(
    fonts.map(async (f) => (await stat(join(dist, "assets", f))).size),
  )
).reduce((a, b) => a + b, 0);
report.consumer.minimal = minimal;
report.consumer.realistic = {
  initial,
  withLazyRenderers: full,
  lazyJsGzip: full.jsGzip - initial.jsGzip,
  fonts: { files: fonts.length, bytes: fontBytes },
};
check(
  "minimal consumer: JS <= 100 KiB gzip",
  minimal.jsGzip <= 102400,
  minimal.jsGzip,
);
check(
  "minimal consumer: CSS <= 20 KiB gzip",
  minimal.cssGzip <= 20480,
  minimal.cssGzip,
);
const minimalCode = (
  await Promise.all(minimal.js.map((f) => readFile(join(dist, f), "utf8")))
).join("\n");
check(
  "minimal consumer: no React, editor or rich renderers",
  !/react-dom|react\/jsx|__SECRET_INTERNALS|DOMPurify|katex|marked|fflate/i.test(
    minimalCode,
  ),
);
check(
  "realistic consumer: rich and media renderers are lazy chunks",
  full.js.length > initial.js.length && full.jsGzip > initial.jsGzip,
);
const allCss = (
  await Promise.all(full.css.map((f) => readFile(join(dist, f), "utf8")))
).join("\n");
// The packages ship fonts as woff2 files; the consumer's bundler may still
// inline a file under its own small-asset limit (Vite: 4 KiB), never a second format.
const inlined = [...allCss.matchAll(/url\(\s*["']?data:([^;,]+)/g)].map(
  (m) => m[1],
);
report.consumer.realistic.inlinedFonts = inlined;
check(
  "realistic consumer: no font duplicated in data: URLs, woff2 only",
  inlined.every((t) => t === "font/woff2") && inlined.length <= 2,
  inlined,
);
check(
  "realistic consumer: KaTeX fonts only as woff2",
  fonts.every((f) => f.endsWith(".woff2")),
  fonts.filter((f) => !f.endsWith(".woff2")),
);
const realisticCode = (
  await Promise.all(full.js.map((f) => readFile(join(dist, f), "utf8")))
).join("\n");
check(
  "realistic consumer: no React or editor",
  !/react-dom|react\/jsx|__SECRET_INTERNALS/.test(realisticCode),
);
await writeFile(
  join(out, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
const failed = report.checks.filter((c) => !c.ok);
console.log(
  JSON.stringify({
    packages: report.packages.map((p) => `${p.file} ${p.bytes} B`),
    minimal: { jsGzip: minimal.jsGzip, cssGzip: minimal.cssGzip },
    realistic: {
      initialJsGzip: initial.jsGzip,
      lazyJsGzip: full.jsGzip - initial.jsGzip,
      cssGzip: full.cssGzip,
      fonts: report.consumer.realistic.fonts,
    },
    checks: `${report.checks.length - failed.length}/${report.checks.length}`,
  }),
);
if (failed.length) process.exitCode = 1;
