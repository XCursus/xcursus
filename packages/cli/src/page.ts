// Page assembly without Node APIs: the CLI and Studio write the same
// standalone HTML from the same code. Hashes use Web Crypto.
import { blockText, defaultMessages, italianMessages } from "@xcursus/player";
import type { ProjectDocument } from "@xcursus/core";
import type { RuntimeConfig } from "./config.js";
import { fontsUsed } from "./profile.js";

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
export async function cspHash(text: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return `'sha256-${base64(new Uint8Array(digest))}'`;
}
/** Standard base64 of bytes, in chunks small enough for String.fromCharCode. */
export function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

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

/**
 * Page layout of exports; the stage fills the window, the print book only
 * prints. Horizontal swipes navigate: touch-action stops at every scroll
 * container (scene content, framed blocks), so pan-y is set on each of
 * them; code blocks keep horizontal scrolling and the outline keeps zoom.
 * The outline scrolls its last item above the on-screen buttons.
 */
export function pageCSS(document: ProjectDocument, capture: boolean) {
  const { width, height } = document.settings.viewport;
  return capture
    ? `html,body{margin:0;padding:0;background:#fff;overflow:hidden}#xcursus-stage{position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden}@page{size:${width}px ${height}px;margin:0}`
    : `html,body{margin:0;height:100%}#xcursus-stage{position:fixed;inset:0;touch-action:pan-y}#xcursus-stage :not(pre,pre *,.xc-outline,.xc-outline *){touch-action:pan-y}#xcursus-stage .xc-outline{padding-bottom:76px}.xc-noscript{padding:16px;font-family:system-ui,sans-serif}.xc-export-placeholder{margin:0;padding:8px}.xc-export-nav{position:fixed;right:16px;bottom:16px;z-index:2;display:flex;gap:8px}.xc-export-nav button{min-width:44px;min-height:44px;padding:8px 14px;border:1px solid #53637b;border-radius:6px;background:#fff;color:#172035;font:16px system-ui,sans-serif;cursor:pointer}.xc-export-nav button:disabled{opacity:.6;cursor:default}.xc-export-nav button:focus-visible{outline:3px solid #1169d4;outline-offset:3px}`;
}

export interface EmbeddedFont {
  file: string;
  byteLength: number;
  sha256: string;
}
/** A published stylesheet with its woff2 files inlined once as data: URLs. */
export interface KitStylesheet {
  css: string;
  fonts: EmbeddedFont[];
}
/**
 * What a standalone page embeds besides the project: the export runtime, its
 * third-party notices and the stylesheets. The CLI reads it from its files;
 * Studio loads the copy written at build time.
 */
export interface ExportKit {
  version: string;
  script: string;
  notices: string;
  stylesheets: {
    player: KitStylesheet;
    fonts: KitStylesheet;
    katex: KitStylesheet;
  };
}
/** Stylesheet names of the kit, in page order. */
export const STYLESHEETS = [
  ["player", "player.css"],
  ["fonts", "fonts.css"],
  ["katex", "katex.css"],
] as const;
/** Only the stylesheets the document needs, concatenated in page order. */
export function kitStyles(kit: ExportKit, document: ProjectDocument) {
  const used = fontsUsed(document);
  let css = "";
  const fonts: EmbeddedFont[] = [];
  for (const [key, name] of STYLESHEETS) {
    if ((key === "fonts" && !used.theme) || (key === "katex" && !used.katex))
      continue;
    const sheet = kit.stylesheets[key];
    css += `/* ${name} */\n${sheet.css}\n`;
    fonts.push(...sheet.fonts);
  }
  return { css, fonts };
}

export interface PageParts {
  document: ProjectDocument;
  config: RuntimeConfig;
  css: string;
  runtime: string;
  notices: string;
  /** Inline profile: base64 assets; files profile: their relative names. */
  assets: Record<string, string>;
  /** Tool named in the header comment and the generator meta, e.g. "XCursus CLI 0.6.0". */
  generator: string;
  capture?: boolean;
}
/** Standalone HTML or capture page: everything inline, CSP with hashes, connect-src 'none'. */
export async function standalonePage(parts: PageParts) {
  const { document } = parts;
  const css = `${parts.css}\n${pageCSS(document, !!parts.capture)}`;
  if (/<\/style/i.test(css)) throw new Error("Unsafe stylesheet");
  const script = inlineScript(parts.runtime);
  const scriptHash = await cspHash(script),
    styleHash = await cspHash(css);
  const csp = [
    "default-src 'none'",
    `script-src ${scriptHash}`,
    `style-src ${styleHash}`,
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
  const generator = escapeHTML(parts.generator);
  const html = `<!doctype html>
<!-- ${escapeHTML(document.metadata.title || "XCursus")} | exported with ${generator}. The embedded XCursus runtime is free software under GPL-3.0-or-later, source: https://github.com/XCursus/xcursus. Third-party licences: the template #xcursus-notices below. -->
<html lang="${escapeHTML(document.metadata.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="${generator}">
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
  return { html, csp, scriptHash, styleHash };
}
