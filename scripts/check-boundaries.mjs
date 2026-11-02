import { readFile, readdir } from "node:fs/promises";
const walk = async (p) =>
  (
    await Promise.all(
      (await readdir(p, { withFileTypes: true })).map((e) =>
        e.isDirectory() ? walk(`${p}/${e.name}`) : `${p}/${e.name}`,
      ),
    )
  ).flat();
const issues = [];
for (const name of ["core", "player"]) {
  const manifest = JSON.parse(
    await readFile(`packages/${name}/package.json`, "utf8"),
  );
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    if (
      /react|editor|plugins|cli|impress/.test(dependency) ||
      (name === "core" && dependency.includes("player"))
    )
      issues.push(`${name}: ${dependency}`);
  for (const file of await walk(`packages/${name}/src`)) {
    const source = await readFile(file, "utf8");
    if (
      /\b(?:eval|Function)\s*\(|\.innerHTML\s*=|https?:\/\//.test(source) &&
      !file.endsWith("validator.js")
    )
      issues.push(`${file}: unsafe runtime operation`);
    if (
      name === "core" &&
      /\b(?:window|HTMLElement|requestAnimationFrame|localStorage|fetch)\b|from ['"](?:node:|@xcursus\/(?:player|editor)|react)/.test(
        source,
      )
    )
      issues.push(`${file}: core boundary`);
    if (/from ['"](?:react|@xcursus\/(?:editor|plugins))/.test(source))
      issues.push(`${file}: forbidden import`);
  }
  const built = await readFile(`packages/${name}/dist/index.js`, "utf8");
  if (
    /new Function|eval\(|Ajv|react-dom|react\/jsx|@xcursus\/editor/.test(built)
  )
    issues.push(`${name}: forbidden bundled code`);
}
// CLI (0.6): core validates, player and plugins render in the browser; the
// editor and React never enter the CLI or the export runtime it embeds.
const cli = JSON.parse(await readFile("packages/cli/package.json", "utf8"));
for (const dependency of Object.keys(cli.dependencies ?? {}))
  if (/react|editor/.test(dependency)) issues.push(`cli: ${dependency}`);
for (const file of await walk("packages/cli/src"))
  if (
    /from ['"](?:react|react-dom|@xcursus\/editor)/.test(
      await readFile(file, "utf8"),
    )
  )
    issues.push(`${file}: forbidden import`);
// `@xcursus/cli/html` also runs in Studio: its modules use no Node API.
for (const file of ["html", "page", "profile", "config"].map(
  (name) => `packages/cli/src/${name}.ts`,
))
  if (
    /from ['"](?:node:|playwright|pdf-lib|\.\/(?:io|assemble|commands|capture)\.js)/.test(
      await readFile(file, "utf8"),
    )
  )
    issues.push(
      `${file}: Node or capture import in the browser-safe HTML pipeline`,
    );
if (
  /react-dom|react\/jsx|__SECRET_INTERNALS|@xcursus\/editor|new Function\(|eval\(/.test(
    await readFile("packages/cli/dist/runtime/xcursus-runtime.js", "utf8"),
  )
)
  issues.push("cli: export runtime contains editor, React or dynamic code");
// impress.js importer (1.0): core and an inert parser only; no DOM, network,
// file system or dynamic code, and nothing in the player depends on it.
const impress = JSON.parse(
  await readFile("packages/impress-compat/package.json", "utf8"),
);
for (const dependency of Object.keys(impress.dependencies ?? {}))
  if (!["@xcursus/core", "gl-matrix", "parse5"].includes(dependency))
    issues.push(`impress-compat: ${dependency}`);
for (const file of await walk("packages/impress-compat/src")) {
  const source = await readFile(file, "utf8");
  if (
    /\b(?:eval|Function)\s*\(|\.innerHTML\s*=|\b(?:window|globalThis)\.|\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|requestAnimationFrame|\bimport\s*\(|\bdocument\.(?:create|query|get|body|cookie|write)|from ['"](?:node:|react|@xcursus\/(?:player|plugins|editor|cli))/.test(
      source,
    )
  )
    issues.push(`${file}: importer boundary`);
}
for (const name of ["core", "player", "plugins", "editor"])
  for (const file of await walk(`packages/${name}/src`))
    if (
      /(?:\bfrom|\bimport)\s*\(?\s*['"]@xcursus\/impress-compat/.test(
        await readFile(file, "utf8"),
      )
    )
      issues.push(`${file}: imports the impress.js importer`);
if (
  /new Function|eval\(|react|@xcursus\/(?:player|editor)/.test(
    await readFile("packages/impress-compat/dist/index.js", "utf8"),
  )
)
  issues.push("impress-compat: forbidden bundled code");
if (
  /parse5|impress-compat/.test(
    await readFile("packages/cli/dist/runtime/xcursus-runtime.js", "utf8"),
  )
)
  issues.push("cli: export runtime contains the importer");
if (issues.length) throw new Error(issues.join("\n"));
const editor = JSON.parse(
  await readFile("packages/editor/package.json", "utf8"),
);
for (const dependency of Object.keys(editor.dependencies ?? {}))
  if (
    !["@xcursus/core", "@xcursus/player", "@xcursus/plugins"].includes(
      dependency,
    )
  )
    throw new Error(`Unexpected editor dependency: ${dependency}`);
for (const peer of ["react", "react-dom"])
  if (!editor.peerDependencies?.[peer])
    throw new Error(`Missing editor peer: ${peer}`);
console.log(
  "Boundaries: core/player isolated; importer on core and parse5 only, never in player, editor or export runtime; CLI and export runtime without editor or React; editor registers optional plugins and React peers",
);
const plugins = JSON.parse(
  await readFile("packages/plugins/package.json", "utf8"),
);
for (const dep of Object.keys(plugins.dependencies ?? {}))
  if (
    ![
      "@xcursus/core",
      "@xcursus/player",
      "dompurify",
      "marked",
      "katex",
      "fflate",
    ].includes(dep)
  )
    throw new Error(`Unexpected plugin dependency: ${dep}`);
