import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";
const source = (path: string) => new URL(path, import.meta.url).pathname;
/**
 * Versioned offline shell: the worker precaches every built file under a cache
 * named after a digest of the build. Activation waits for the user (no
 * skipWaiting on install); on activation only older `xcursus-studio-`
 * caches, and the `spatialdeck-studio-` caches of releases made before the
 * rename, are deleted. Navigations are served from the cache first.
 */
function offlineShell(): Plugin {
  return {
    name: "xcursus-offline-shell",
    apply: "build",
    // After Vite has emitted the HTML pages, so they are precached too.
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith(".map"))
        .sort();
      const digest = createHash("sha256");
      for (const name of files) {
        const output = bundle[name]!;
        digest.update(name);
        digest.update(output.type === "chunk" ? output.code : output.source);
      }
      const version = digest.digest("hex").slice(0, 16);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `// XCursus Studio offline shell, generated at build time.
const PREFIX = "xcursus-studio-";
// Caches and activation message of the releases published as SpatialDeck Studio.
const LEGACY_PREFIX = "spatialdeck-studio-";
const CACHE = PREFIX + ${JSON.stringify(version)};
const SHELL = ${JSON.stringify(["./", ...files])};
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith(PREFIX) || k.startsWith(LEGACY_PREFIX)) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "xcursus-sw-activate" || type === "spatialdeck-sw-activate") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    const page = url.pathname.endsWith("/present.html") ? "present.html" : "index.html";
    event.respondWith(
      caches.open(CACHE).then((cache) => cache.match(page)).then((hit) => hit || fetch(request)),
    );
    return;
  }
  // Module scripts and stylesheets are CORS requests: the cached copies were
  // fetched without an Origin header, so Vary must not prevent the match.
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(request, { ignoreVary: true })).then((hit) => hit || fetch(request)),
  );
});
`,
      });
    },
  };
}
export default defineConfig({
  root: source("."),
  plugins: [
    react(),
    offlineShell(),
    {
      // The dev server needs its HMR websocket; production keeps connect-src 'self'.
      name: "xcursus-dev-csp",
      apply: "serve",
      transformIndexHtml: (html) =>
        html.replace("connect-src 'self';", "connect-src 'self' ws:;"),
    },
  ],
  resolve: {
    alias: [
      {
        find: "@xcursus/plugins/style.css",
        replacement: source("../../packages/plugins/src/katex.css"),
      },
      {
        find: "@xcursus/plugins",
        replacement: source("../../packages/plugins/src"),
      },
      {
        find: /^@xcursus\/editor$/,
        replacement: source("../../packages/editor/src/browser.ts"),
      },
      {
        find: /^@xcursus\/core$/,
        replacement: source("../../packages/core/src/index.ts"),
      },
      {
        find: "@xcursus/player/presenter",
        replacement: source("../../packages/player/src/presenter.ts"),
      },
      {
        find: /^@xcursus\/player$/,
        replacement: source("../../packages/player/src/index.ts"),
      },
      {
        find: "@xcursus/player/style.css",
        replacement: source("../../packages/player/src/style.css"),
      },
      {
        find: "@xcursus/player/fonts.css",
        replacement: source("../../packages/player/src/fonts.css"),
      },
    ],
  },
  build: {
    target: ["chrome120", "firefox120", "safari17"],
    assetsInlineLimit: 0,
    rollupOptions: {
      // Studio and the public window of the presenter view (no React there).
      input: { main: source("index.html"), present: source("present.html") },
    },
  },
  server: { host: "127.0.0.1", port: 5174 },
});
