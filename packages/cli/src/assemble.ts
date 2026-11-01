import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockText, defaultMessages, italianMessages } from "@xcursus/player";
import type { ProjectDocument } from "@xcursus/core";
import type { RuntimeConfig } from "./config.js";
import { fontsUsed } from "./profile.js";

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
/** The published stylesheets the document needs: player, theme fonts, KaTeX. */
export async function stylesheets(
  document: ProjectDocument,
): Promise<Stylesheet[]> {
  const player = packageDir("@xcursus/player"),
    plugins = packageDir("@xcursus/plugins");
  const used = fontsUsed(document);
  const sheets: Array<[string, string]> = [
    ["player.css", join(player, "dist", "player.css")],
  ];
  if (used.theme) sheets.push(["fonts.css", join(player, "dist", "fonts.css")]);
  if (used.katex)
    sheets.push(["katex.css", join(plugins, "dist", "plugins.css")]);
  return Promise.all(
    sheets.map(async ([name, path]) => {
      const css = await readFile(path, "utf8");
      const fonts = [
        ...css.matchAll(/url\("?\.\/fonts\/([A-Za-z0-9_.-]+\.woff2)"?\)/g),
      ].map((m) => ({
        file: m[1]!,
        path: join(dirname(path), "fonts", m[1]!),
      }));
      return { name, css, fonts };
    }),
  );
}
export interface EmbeddedFont {
  file: string;
  byteLength: number;
  sha256: string;
}
/** Same stylesheets with every woff2 file inlined once as a data: URL (single format). */
export async function inlineFonts(sheets: Stylesheet[]) {
  const fonts: EmbeddedFont[] = [];
  let css = "";
  for (const sheet of sheets) {
    let text = sheet.css;
    for (const font of sheet.fonts) {
      const bytes = await readFile(font.path);
      fonts.push({
        file: font.file,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      text = text.replace(
        new RegExp(
          `url\\("?\\./fonts/${font.file.replace(/\./g, "\\.")}"?\\)`,
          "g",
        ),
        `url(data:font/woff2;base64,${bytes.toString("base64")})`,
      );
    }
    css += `/* ${sheet.name} */\n${text}\n`;
  }
  return { css, fonts };
}

/** JSON inside <script type="application/json">: nothing can close the element or start markup. */
export const scriptJSON = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
/** Inline classic script text that cannot end its element early; valid in strings, templates and regexes. */
export function inlineScript(source: string) {
  const text = source
    .replace(/<\/(script)/gi, "\\x3C/$1")
    .replace(/<!--/g, "\\x3C!--");
  if (/<\/script|<!--/i.test(text)) throw new Error("Unsafe inline script");
  return text;
}
export const escapeHTML = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export const cspHash = (text: string) =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** Static outline for <noscript>: titles and accessible texts of the default path, escaped. */
export function noscriptOutline(document: ProjectDocument, lang: "en" | "it") {
  const messages = lang === "it" ? italianMessages : defaultMessages;
  const path = document.paths.find((p) => p.id === document.defaultPathId);
  const seen = new Set<string>(),
    order: string[] = [];
  const stack = path?.startNodeId ? [path.startNodeId] : [];
  while (stack.length && path) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    stack.push(
      ...path.edges
        .filter((e) => e.from === id)
        .map((e) => e.to)
        .reverse(),
    );
  }
  const items = order.map((nodeId) => {
    const node = path!.nodes.find((n) => n.id === nodeId)!;
    const scene = document.scenes.find((s) => s.id === node.sceneId)!;
    const texts = scene.blocks
      .map((b) => blockText(b, messages))
      .filter((t) => t !== "")
      .map((t) => `<p>${escapeHTML(t)}</p>`)
      .join("");
    return `<li><h2>${escapeHTML(scene.title)}</h2>${texts}</li>`;
  });
  return `<noscript><section class="xc-noscript"><p>${escapeHTML(
    lang === "it"
      ? "Vista testuale statica: JavaScript è disattivato."
      : "Static text view: JavaScript is disabled.",
  )}</p><ol>${items.join("")}</ol></section></noscript>`;
}

/** Page layout of exports; the stage fills the window, the print book only prints. */
export function pageCSS(document: ProjectDocument, capture: boolean) {
  const { width, height } = document.settings.viewport;
  return capture
    ? `html,body{margin:0;padding:0;background:#fff;overflow:hidden}#xcursus-stage{position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden}@page{size:${width}px ${height}px;margin:0}`
    : `html,body{margin:0;height:100%}#xcursus-stage{position:fixed;inset:0}.xc-noscript{padding:16px;font-family:system-ui,sans-serif}.xc-export-placeholder{margin:0;padding:8px}`;
}

export interface PageParts {
  document: ProjectDocument;
  config: RuntimeConfig;
  css: string;
  runtime: string;
  notices: string;
  /** Inline profile: base64 assets; files profile: their relative names. */
  assets: Record<string, string>;
  capture?: boolean;
}
/** Standalone HTML or capture page: everything inline, CSP with hashes, connect-src 'none'. */
export function standalonePage(parts: PageParts) {
  const { document } = parts;
  const css = `${parts.css}\n${pageCSS(document, !!parts.capture)}`;
  if (/<\/style/i.test(css)) throw new Error("Unsafe stylesheet");
  const script = inlineScript(parts.runtime);
  const csp = [
    "default-src 'none'",
    `script-src ${cspHash(script)}`,
    `style-src ${cspHash(css)}`,
    "img-src blob:",
    "media-src blob:",
    "font-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const html = `<!doctype html>
<!-- ${escapeHTML(document.metadata.title || "XCursus")} | exported with XCursus CLI ${toolVersion}. The embedded XCursus runtime is free software under GPL-3.0-or-later, source: https://github.com/XCursus/xcursus. Third-party licences: the template #xcursus-notices below. -->
<html lang="${escapeHTML(document.metadata.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="XCursus CLI ${toolVersion}">
<title>${escapeHTML(document.metadata.title || "XCursus")}</title>
<style>${css}</style>
</head>
<body>
<div id="xcursus-stage"></div>
${parts.capture ? "" : noscriptOutline(document, parts.config.messages)}
<script type="application/json" id="xcursus-config">${scriptJSON(parts.config)}</script>
<script type="application/json" id="xcursus-project">${scriptJSON(document)}</script>
<script type="application/json" id="xcursus-assets">${scriptJSON(parts.assets)}</script>
<template id="xcursus-notices"><pre>${escapeHTML(parts.notices)}</pre></template>
<script>${script}</script>
</body>
</html>
`;
  return { html, csp, scriptHash: cspHash(script), styleHash: cspHash(css) };
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
export const pageStyle = pageCSS;
