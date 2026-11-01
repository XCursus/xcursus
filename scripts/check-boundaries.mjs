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
if (
  /react-dom|react\/jsx|__SECRET_INTERNALS|@xcursus\/editor|new Function\(|eval\(/.test(
    await readFile("packages/cli/dist/runtime/xcursus-runtime.js", "utf8"),
  )
)
  issues.push("cli: export runtime contains editor, React or dynamic code");
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
  "Boundaries: core/player isolated; CLI and export runtime without editor or React; editor registers optional plugins and React peers",
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
