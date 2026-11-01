import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
// Shared by the library Vite configs (0.6 packaging): third-party packages stay
// external dependencies of the ESM libraries, and every artefact that does
// embed them (IIFE, standalone HTML runtime) ships a generated notice file.

/** Licences accepted for code or fonts embedded in a GPL-3.0-or-later artefact. */
export const compatibleLicenses = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "MPL-2.0 OR Apache-2.0",
  "(MPL-2.0 OR Apache-2.0)",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "OFL-1.1",
]);

/** Rollup `external` for a package manifest: its dependencies and peers, with subpaths. */
export function externalDependencies(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const names = Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  });
  return (id) => names.some((name) => id === name || id.startsWith(`${name}/`));
}

/** Fails a library build if a chunk contains a module from node_modules. */
export function noBundledDependencies() {
  return {
    name: "xcursus-no-bundled-dependencies",
    generateBundle(_options, bundle) {
      const bundled = [];
      for (const output of Object.values(bundle))
        if (output.type === "chunk")
          for (const id of output.moduleIds)
            if (id.includes(`${sep}node_modules${sep}`))
              bundled.push(`${output.fileName}: ${id}`);
      if (bundled.length)
        this.error(
          `Third-party code must stay an external dependency:\n${bundled.join("\n")}`,
        );
    },
  };
}

/** Package root of a module inside node_modules, pnpm layout included. */
function packageRoot(id) {
  const parts = id.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return null;
  const scoped = parts[at + 1]?.startsWith("@");
  return parts.slice(0, at + (scoped ? 3 : 2)).join(sep);
}
function licenseText(root) {
  const file = readdirSync(root).find((name) =>
    /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(name),
  );
  if (!file) throw new Error(`No licence file in ${root}`);
  return readFileSync(join(root, file), "utf8").trim();
}

/**
 * Notice text for the third-party packages among `moduleIds`, plus `extra`
 * package roots (fonts, CSS) embedded by other means. Throws when a package
 * has no licence file or a licence outside `compatibleLicenses`.
 */
/** @param {{ title: string, moduleIds: string[], extra?: string[] }} options */
export function thirdPartyNotices({ title, moduleIds, extra = [] }) {
  const roots = new Map();
  for (const root of [
    ...moduleIds.map((id) => packageRoot(id)),
    ...extra,
  ].filter(Boolean)) {
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    roots.set(manifest.name, { root, manifest });
  }
  const packages = [...roots.values()].sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  );
  const sections = packages.map(({ root, manifest }) => {
    if (!compatibleLicenses.has(manifest.license))
      throw new Error(
        `${manifest.name}: licence ${manifest.license} not verified for GPL-3.0-or-later`,
      );
    const source =
      typeof manifest.repository === "string"
        ? manifest.repository
        : (manifest.repository?.url ?? manifest.homepage ?? "");
    return [
      `${manifest.name} ${manifest.version}`,
      `License: ${manifest.license}`,
      ...(source ? [`Source: ${source}`] : []),
      "",
      licenseText(root),
    ].join("\n");
  });
  return {
    packages: packages.map(({ manifest }) => ({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
    })),
    text: [
      title,
      "",
      "XCursus is free software: GPL-3.0-or-later. Corresponding source:",
      "https://github.com/XCursus/xcursus",
      "",
      `This artefact embeds the following ${packages.length} third-party packages,`,
      "each under its own licence reproduced below.",
      "",
      ...sections.flatMap((s) => ["=".repeat(72), s, ""]),
    ].join("\n"),
  };
}

/**
 * Emits `fileName` with the notices of every module bundled in the output.
 * @param {{ fileName: string, title: string, extra?: string[] }} options
 */
export function licenseNotices({ fileName, title, extra = [] }) {
  return {
    name: "xcursus-license-notices",
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap((o) =>
        o.type === "chunk" ? o.moduleIds : [],
      );
      this.emitFile({
        type: "asset",
        fileName,
        source: thirdPartyNotices({ title, moduleIds: ids, extra }).text,
      });
    },
  };
}

/** Directory of an installed package, resolved from `from` (a package directory). */
export function installedPackage(name, from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${name} not installed from ${from}`);
    dir = parent;
  }
}

/**
 * Prepends a licence banner to every JavaScript chunk after minification,
 * which would otherwise drop the comment.
 * @param {string} text
 */
export function licenseBanner(text) {
  return {
    name: "xcursus-license-banner",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle))
        if (output.type === "chunk") output.code = `${text}\n${output.code}`;
    },
  };
}
