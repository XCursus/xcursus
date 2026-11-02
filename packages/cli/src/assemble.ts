import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectDocument } from "@xcursus/core";
import type { RuntimeConfig } from "./config.js";
import {
  STYLESHEETS,
  escapeHTML,
  noscriptOutline,
  scriptJSON,
} from "./page.js";
import type { EmbeddedFont, ExportKit } from "./page.js";
import { fontsUsed } from "./profile.js";

export {
  cspHash,
  escapeHTML,
  inlineScript,
  noscriptOutline,
  pageCSS,
  scriptJSON,
  standalonePage,
} from "./page.js";
export type { EmbeddedFont, ExportKit, PageParts } from "./page.js";

const require = createRequire(import.meta.url);
const packageDir = (name: string) =>
  dirname(require.resolve(`${name}/package.json`));
const own = join(dirname(fileURLToPath(import.meta.url)), "..");

export const toolVersion = (
  JSON.parse(await readFile(join(own, "package.json"), "utf8")) as {
    version: string;
  }
).version;

export interface RuntimeFiles {
  script: string;
  notices: string;
}
/** The export runtime built with this package, and its generated notices. */
export async function runtimeFiles(): Promise<RuntimeFiles> {
  const dir = join(own, "dist", "runtime");
  return {
    script: await readFile(join(dir, "xcursus-runtime.js"), "utf8"),
    notices: await readFile(join(dir, "THIRD_PARTY_NOTICES.txt"), "utf8"),
  };
}

export interface Stylesheet {
  name: string;
  css: string;
  /** Font files referenced as ./fonts/<file>, with their directory. */
  fonts: Array<{ file: string; path: string }>;
}
const sheetFiles = () => {
  const player = packageDir("@xcursus/player"),
    plugins = packageDir("@xcursus/plugins");
  return {
    player: join(player, "dist", "player.css"),
    fonts: join(player, "dist", "fonts.css"),
    katex: join(plugins, "dist", "plugins.css"),
  };
};
async function readStylesheet(name: string, path: string): Promise<Stylesheet> {
  const css = await readFile(path, "utf8");
  const fonts = [
    ...css.matchAll(/url\("?\.\/fonts\/([A-Za-z0-9_.-]+\.woff2)"?\)/g),
  ].map((m) => ({
    file: m[1]!,
    path: join(dirname(path), "fonts", m[1]!),
  }));
  return { name, css, fonts };
}
/** The published stylesheets the document needs: player, theme fonts, KaTeX. */
export async function stylesheets(
  document: ProjectDocument,
): Promise<Stylesheet[]> {
  const used = fontsUsed(document),
    files = sheetFiles();
  return Promise.all(
    STYLESHEETS.filter(
      ([key]) =>
        key === "player" ||
        (key === "fonts" && used.theme) ||
        (key === "katex" && used.katex),
    ).map(([key, name]) => readStylesheet(name, files[key])),
  );
}
/** A stylesheet with every woff2 file inlined once as a data: URL (single format). */
async function inlineSheet(sheet: Stylesheet) {
  const fonts: EmbeddedFont[] = [];
  let css = sheet.css;
  for (const font of sheet.fonts) {
    const bytes = await readFile(font.path);
    fonts.push({
      file: font.file,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    css = css.replace(
      new RegExp(
        `url\\("?\\./fonts/${font.file.replace(/\./g, "\\.")}"?\\)`,
        "g",
      ),
      `url(data:font/woff2;base64,${bytes.toString("base64")})`,
    );
  }
  return { css, fonts };
}
/**
 * Runtime, notices and every stylesheet with inlined fonts: what a standalone
 * page needs besides the project. Studio embeds the same kit at build time.
 */
export async function exportKit(): Promise<ExportKit> {
  const runtime = await runtimeFiles(),
    files = sheetFiles();
  const sheet = async (key: keyof typeof files, name: string) =>
    inlineSheet(await readStylesheet(name, files[key]));
  return {
    version: toolVersion,
    script: runtime.script,
    notices: runtime.notices,
    stylesheets: {
      player: await sheet("player", "player.css"),
      fonts: await sheet("fonts", "fonts.css"),
      katex: await sheet("katex", "katex.css"),
    },
  };
}

/** index.html of a static build: runtime, styles and assets are same-origin files. */
export function buildPage(
  document: ProjectDocument,
  config: RuntimeConfig,
  styles: string[],
  files: Record<string, string>,
) {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    // 'self' for the icon browsers request on their own; content images are blob: URLs.
    "img-src 'self' blob:",
    "media-src blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<!-- ${escapeHTML(document.metadata.title || "XCursus")} | built with XCursus CLI ${toolVersion}; serve over HTTP(S). Runtime under GPL-3.0-or-later, source: https://github.com/XCursus/xcursus; third-party licences in THIRD_PARTY_NOTICES.txt. -->
<html lang="${escapeHTML(document.metadata.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="XCursus CLI ${toolVersion}">
<title>${escapeHTML(document.metadata.title || "XCursus")}</title>
${styles.map((s) => `<link rel="stylesheet" href="${escapeHTML(s)}">`).join("\n")}
</head>
<body>
<div id="xcursus-stage"></div>
${noscriptOutline(document, config.messages)}
<script type="application/json" id="xcursus-config">${scriptJSON(config)}</script>
<script type="application/json" id="xcursus-files">${scriptJSON(files)}</script>
<script src="xcursus-runtime.js" defer></script>
</body>
</html>
`;
}
export { pageCSS as pageStyle } from "./page.js";
