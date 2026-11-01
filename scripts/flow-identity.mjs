import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { release } from "node:os";
/*
 * Rendering identity of the historical flow fixtures between two playground
 * builds, for example 0.4.1 (schema 1.2.0) and the current tree. Not part of
 * the suites: it needs a second build, served next to the current one.
 *
 *   git worktree add --detach <dir> <baseline-commit>
 *   (cd <dir> && pnpm install --frozen-lockfile --offline && pnpm build)
 *   pnpm --dir <dir> --filter @xcursus/playground exec vite preview --port 4191
 *   pnpm --filter @xcursus/playground exec vite preview --port 4192
 *   node scripts/flow-identity.mjs --baseline=http://127.0.0.1:4191 --current=http://127.0.0.1:4192
 *
 * Every node of the default path of /core, /structure and /content is shown
 * with the same viewport, DPR 1 and reduced motion; the script compares the
 * geometry of contents, titles and blocks and every pixel of the player.
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")),
);
const out = args.out ?? "test-results/flow-identity";
if (!args.baseline || !args.current)
  throw new Error("Usage: --baseline=<url> --current=<url> [--out=<dir>]");
// The browser library behind each pinned runner; the test runner itself may
// be loaded only once per process. macOS 14 runs WebKit through 1.61.1.
const library = (from) => {
  const runner = createRequire(from).resolve("@playwright/test/package.json");
  const browsers = createRequire(runner).resolve("playwright/package.json");
  return createRequire(browsers)("playwright-core");
};
const current = library(import.meta.url);
const webkitLibrary =
  process.platform === "darwin" && release().startsWith("23.")
    ? library(new URL("../tools/webkit-macos14/package.json", import.meta.url))
    : current;
const engines = {
  chromium: current.chromium,
  firefox: current.firefox,
  webkit: webkitLibrary.webkit,
};
const only = args.engines?.split(",") ?? Object.keys(engines);
async function capture(page, base, route) {
  await page.goto(base + route);
  await page.waitForFunction(
    () => document.querySelectorAll(".xc-player").length === 2,
  );
  const nodes = await page.evaluate(() => {
    const d = window.demoDocument;
    return d.paths.find((p) => p.id === d.defaultPathId).nodes.map((n) => n.id);
  });
  const shots = [];
  for (const node of nodes) {
    await page.evaluate(async (nodeId) => {
      await window.demoPlayers[0].goTo({ nodeId }, { durationMs: 0 });
      await document.fonts.ready;
      const settled = () =>
        [...document.querySelectorAll("#player-1 .xc-block")].every(
          (b) =>
            !/Caricamento/.test(b.textContent ?? "") &&
            [...b.querySelectorAll("video")].every((v) => v.readyState >= 2) &&
            [...b.querySelectorAll("img")].every((i) => i.complete),
        );
      for (let i = 0; i < 200 && !settled(); i++)
        await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    }, node);
    const geometry = await page.evaluate(() => {
      const r = (e) => {
        const b = e.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height].map(
          (n) => Math.round(n * 100) / 100,
        );
      };
      const scene = document.querySelector(
        '#player-1 .xc-scene[data-active="true"]',
      );
      return {
        content: r(scene.querySelector(".xc-content")),
        title: r(scene.querySelector("h2")),
        blocks: [...scene.querySelectorAll("[data-block-id]")].map((b) => [
          b.dataset.blockId,
          ...r(b),
        ]),
      };
    });
    // Native media controls (spinner, decoded frame, clock) are not
    // deterministic between loads: masked here, their boxes stay in geometry.
    const png = await page.locator("#player-1").screenshot({
      animations: "disabled",
      caret: "hide",
      mask: [page.locator("#player-1 video, #player-1 audio")],
    });
    shots.push({ node, geometry, png });
  }
  return shots;
}
async function diff(page, a, b) {
  return page.evaluate(
    async ([a, b]) => {
      const load = async (data) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      };
      const x = await load(a),
        y = await load(b);
      if (x.width !== y.width || x.height !== y.height)
        return {
          size: [x.width, x.height, y.width, y.height],
          pixels: -1,
          max: 255,
        };
      let pixels = 0,
        max = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        let changed = false;
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(x.data[i + c] - y.data[i + c]);
          if (d) changed = true;
          if (d > max) max = d;
        }
        if (changed) pixels++;
      }
      return {
        size: [x.width, x.height],
        pixels,
        total: x.width * x.height,
        max,
      };
    },
    [a.toString("base64"), b.toString("base64")],
  );
}
const report = { baseline: args.baseline, current: args.current, engines: {} };
let failures = 0;
// Pixels are compared in one Chromium page for every engine's screenshots.
const differ = await engines.chromium.launch();
const diffPage = await differ.newPage();
for (const name of only) {
  const browser = await engines[name].launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const results = [];
  for (const route of ["/core", "/structure", "/content"]) {
    const before = await capture(page, args.baseline, route);
    const after = await capture(page, args.current, route);
    console.log(`${name} ${route}: ${before.length} views captured`);
    for (const [i, shot] of before.entries()) {
      const other = after[i];
      const pixels = await diff(diffPage, shot.png, other.png);
      const geometry =
        JSON.stringify(shot.geometry) === JSON.stringify(other.geometry);
      if (!geometry || pixels.pixels !== 0) {
        failures++;
        await mkdir(`${out}/${name}`, { recursive: true });
        await writeFile(
          `${out}/${name}${route}-${shot.node}-baseline.png`,
          shot.png,
        );
        await writeFile(
          `${out}/${name}${route}-${shot.node}-current.png`,
          other.png,
        );
      }
      results.push({ route, node: shot.node, geometry, ...pixels });
    }
  }
  report.engines[name] = { version: browser.version(), results };
  await browser.close();
}
await differ.close();
await mkdir(out, { recursive: true });
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + "\n");
for (const [name, e] of Object.entries(report.engines))
  console.log(
    `${name} ${e.version}: ${e.results.length} views, ${e.results.filter((r) => r.geometry && r.pixels === 0).length} identical, max differing pixels ${Math.max(...e.results.map((r) => r.pixels))}`,
  );
process.exitCode = failures ? 1 : 0;
