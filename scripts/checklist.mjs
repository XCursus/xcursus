import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preview, serveDir } from "./preview.mjs";
import { Key, startBrowser } from "./webdriver.mjs";

// The manual checklist of docs/RELEASE_BLOCKERS.md in real browsers, on the
// production builds (run `pnpm build` first):
//
//   node scripts/checklist.mjs --browser safari|firefox [--only 1,3]
//     items 1–5 (player, Studio, impress.js import, exported HTML,
//     presenter) through WebDriver: real clicks, keys, pointer drags, file
//     inputs, windows and full screen. Safari needs remote automation
//     (`safaridriver --enable`); Firefox uses geckodriver, with
//     FIREFOX_BINARY and GECKODRIVER selecting the builds.
//   node scripts/checklist.mjs --browser ios-phone|ios-tablet|android
//     item 6 (touch) with real touch input: Safari in the iOS Simulator
//     through safaridriver, or Chrome on an Android device or emulator
//     reached with adb (ADB) and the DevTools protocol.
//
// Results, the environment and screenshots go to test-results/checklist/;
// the exit code is non-zero when a check fails. Stand-ins, recorded as
// such: the archive download is captured in the page instead of a save
// dialog, the blocked pop-up is a `window.open` that returns null, offline
// is proven by counting remote requests, and on touch devices Studio's file
// input is filled by script (there is no system file picker to drive).

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const browser = option("--browser", "safari");
const touchTarget = ["ios-phone", "ios-tablet", "android"].includes(browser);
const out = join(root, "test-results/checklist", browser);
// Files the browser reads from disk (file inputs, file:// pages) are copied
// here first: XCURSUS_STAGE, by default the results folder.
const stage = process.env.XCURSUS_STAGE ?? out;
const PLAYGROUND = "http://127.0.0.1:4173";
const STUDIO = "http://127.0.0.1:4174";
const STUDIO_URL = `${STUDIO}/?studio-debug`;
const DECK = "http://127.0.0.1:4175";
const PROJECT_INPUT = 'input[aria-label="JSON project file"]';
const only = option("--only")
  ? new Set(option("--only").split(",").map(Number))
  : null;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A copy of `file` in the staging folder. */
function staged(file) {
  const copy = join(stage, basename(file));
  copyFileSync(file, copy);
  return copy;
}

/** The distribution fixture exported by the packaged CLI, at <dir>/deck.html. */
function exportDeck(dir = out) {
  const html = join(dir, "deck.html");
  rmSync(html, { force: true });
  rmSync(`${html}.manifest.json`, { force: true });
  execFileSync(
    process.execPath,
    [
      join(root, "packages/cli/dist/cli.js"),
      "export",
      "html",
      join(root, "examples/distribution-static/project.json"),
      "--out",
      html,
    ],
    { stdio: "pipe" },
  );
  return html;
}

// ---- checks ----------------------------------------------------------------

const results = [];
let s;
const shot = async (name) =>
  writeFile(join(out, `${name}.png`), await s.screenshot());
function assert(condition, message, details) {
  if (!condition)
    throw new Error(
      details === undefined
        ? message
        : `${message}: ${JSON.stringify(details)}`,
    );
}
async function check(item, name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    results.push({ item, name, ok: true, ms: Date.now() - started, details });
    console.log(`  ok   ${item}. ${name}`);
  } catch (error) {
    results.push({
      item,
      name,
      ok: false,
      ms: Date.now() - started,
      error: error.message,
    });
    console.log(`  FAIL ${item}. ${name}\n       ${error.message}`);
    await shot(`failure-${results.length}`).catch(() => {});
  }
}

// Page functions: they run in Safari and only see their arguments.

/** First element of `selector` in `scope` named `name` (aria-label, label or text). */
const NAMED = (selector, name, scope) => {
  const base = scope ? document.querySelector(scope) : document;
  const label = (e) =>
    (
      e.getAttribute("aria-label") ??
      e.labels?.[0]?.textContent ??
      e.textContent ??
      ""
    ).trim();
  return (
    [...(base?.querySelectorAll(selector) ?? [])].find(
      (e) => label(e) === name && !e.closest("[hidden]"),
    ) ?? null
  );
};
const named = (selector, name, scope = null) => [NAMED, selector, name, scope];
const button = (name, scope = null) => named("button", name, scope);

/** Largest offset, in px, of three landmarks of a scene of the core demo from the core projection. */
const CORE_FRAME = (sceneId) => {
  const scene = window.demoDocument.scenes.find((s) => s.id === sceneId);
  const wrapper = document.querySelector(
    `#player-1 [data-scene-id="${sceneId}"]`,
  );
  const stage = document
    .querySelector("#player-1 .xc-stage")
    .getBoundingClientRect();
  const fit = Math.min(stage.width / 1280, stage.height / 720);
  const zoom = 0.9 * Math.min(1280 / scene.size[0], 720 / scene.size[1]);
  let worst = 0;
  for (const [x, y] of [
    [-scene.size[0] / 2, -scene.size[1] / 2],
    [0, 0],
    [scene.size[0] / 2, scene.size[1] / 2],
  ]) {
    const marker = document.createElement("span");
    marker.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:1px;height:1px`;
    wrapper.append(marker);
    const r = marker.getBoundingClientRect();
    marker.remove();
    worst = Math.max(
      worst,
      Math.abs(r.x - (stage.x + stage.width / 2 + x * zoom * fit)),
      Math.abs(r.y - (stage.y + stage.height / 2 + y * zoom * fit)),
    );
  }
  return worst;
};
/** Where the active scene of the first player sits in its stage. */
const ACTIVE_BOX = () => {
  const player = document.querySelector(".xc-player");
  const stage = player.querySelector(".xc-stage").getBoundingClientRect();
  const scene = player.querySelector('.xc-scene[data-active="true"]');
  const box = scene
    .querySelector(":scope > .xc-content")
    .getBoundingClientRect();
  return {
    sceneId: scene.dataset.sceneId,
    dx: box.x + box.width / 2 - (stage.x + stage.width / 2),
    dy: box.y + box.height / 2 - (stage.y + stage.height / 2),
    fill: Math.max(box.width / stage.width, box.height / stage.height),
    inside:
      box.left >= stage.left - 1 &&
      box.right <= stage.right + 1 &&
      box.top >= stage.top - 1 &&
      box.bottom <= stage.bottom + 1,
  };
};
const framed = (box) =>
  Math.abs(box.dx) <= 1.5 && Math.abs(box.dy) <= 1.5 && box.inside;

/** JSON paths where two values differ (at most ten). */
function diff(a, b, path = "", found = []) {
  if (found.length >= 10) return found;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      diff(a[key], b[key], `${path}/${key}`, found);
  } else if (JSON.stringify(a) !== JSON.stringify(b))
    found.push({ path, saved: a, reopened: b });
  return found;
}

const nodes = () =>
  s.run(() => window.demoPlayers.map((p) => p.getState().nodeId));
const settled = (index, nodeId) =>
  s.waitFor(
    (i, n) => {
      const state = window.demoPlayers[i].getState();
      return state.nodeId === n && !state.transition;
    },
    { args: [index, nodeId], what: `player ${index + 1} at ${nodeId}` },
  );
/** Records navigation start and end times of the first player. */
const record = () =>
  s.run(() => {
    if (!window.navigationTimes) {
      window.navigationTimes = [];
      for (const type of ["navigationstart", "navigationend"])
        window.demoPlayers[0].on(type, () =>
          window.navigationTimes.push({ type, t: performance.now() }),
        );
    }
    window.navigationTimes.length = 0;
  });
const lastDuration = async () =>
  s.waitFor(
    () => {
      const times = window.navigationTimes;
      const end = times.findLastIndex((e) => e.type === "navigationend");
      if (end < 0) return null;
      const start = times
        .slice(0, end)
        .findLast((e) => e.type === "navigationstart");
      const ms = start ? times[end].t - start.t : 0;
      times.length = 0;
      return { ms: Math.round(ms * 10) / 10 };
    },
    { what: "the end of a navigation" },
  );

async function studioReady() {
  await s.waitFor(
    () =>
      !!window.studio?.store &&
      !!document.querySelector(".preview-player .xc-player"),
    { timeout: 20000, what: "Studio" },
  );
}
/** Studio with empty local storage: no recovery from an earlier check. */
async function freshStudio() {
  await s.navigate(STUDIO_URL);
  await studioReady();
  await s.run(async () => {
    for (const db of (await indexedDB.databases?.()) ?? [])
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(db.name);
        request.onsuccess = request.onerror = request.onblocked = resolve;
      });
    localStorage.clear();
    sessionStorage.clear();
  });
  await s.navigate(STUDIO_URL);
  await studioReady();
}
const studioDoc = () => s.run(() => window.studio.store.getSnapshot().document);
const history = () =>
  s.run(() => window.studio.store.getSnapshot().historyLength);
async function openProject(path, scenes) {
  await s.sendKeys(PROJECT_INPUT, path);
  await s.waitFor(
    (n) => window.studio.store.getSnapshot().document.scenes.length === n,
    { args: [scenes], what: `${scenes} scenes in Studio` },
  );
}
async function newWindow(before) {
  for (let i = 0; i < 100; i++) {
    const added = (await s.windows()).filter((h) => !before.includes(h));
    if (added.length) return added[0];
    await delay(100);
  }
  throw new Error("no new window");
}

// ---- 1. Player -------------------------------------------------------------

async function player() {
  await s.navigate(`${PLAYGROUND}/core`);
  await s.waitFor(() => window.demoPlayers?.length === 2, {
    what: "two players",
  });
  await check(
    1,
    "core: every scene is framed by CSS 3D within 1 px",
    async () => {
      const offsets = {};
      for (const [nodeId, sceneId] of [
        ["n1", "intro"],
        ["n2", "detail"],
        ["n3", "end"],
      ]) {
        await s.run(
          (n) => window.demoPlayers[0].goTo({ nodeId: n }, { durationMs: 0 }),
          nodeId,
        );
        offsets[sceneId] = await s.run(CORE_FRAME, sceneId);
        assert(offsets[sceneId] < 1, `${sceneId} off by`, offsets[sceneId]);
        if (sceneId === "detail") await shot("player-core-detail");
      }
      await s.run(() =>
        window.demoPlayers[0].goTo({ nodeId: "n1" }, { durationMs: 0 }),
      );
      return { maxOffsetPx: offsets };
    },
  );
  await check(
    1,
    "core: arrows, Page Up/Down and Space navigate only the focused player",
    async () => {
      await s.run(() => document.querySelector("#player-1").focus());
      const keys = [
        ["ArrowRight", "n2"],
        ["PageDown", "n3"],
        ["PageUp", "n2"],
        ["ArrowLeft", "n1"],
        ["Space", "n2"],
      ];
      for (const [key, nodeId] of keys) {
        await s.press(Key[key]);
        await settled(0, nodeId);
      }
      assert((await nodes()).join() === "n2,n1", "player 2 moved");
      // A text field inside the player keeps its keys.
      await s.click(named("input", "Test input 1"));
      await s.press(Key.ArrowRight, Key.ArrowLeft);
      await delay(500);
      const inField = await nodes();
      assert(inField.join() === "n2,n1", "a text field navigated", inField);
      // Without focus in a player nothing moves.
      await s.run(() => document.activeElement?.blur());
      await s.press(Key.ArrowRight, Key.Space);
      await delay(500);
      const unfocused = await nodes();
      assert(
        unfocused.join() === "n2,n1",
        "navigated without focus",
        unfocused,
      );
      await s.run(() => document.querySelector("#player-2").focus());
      await s.press(Key.ArrowRight);
      await settled(1, "n2");
      const both = await nodes();
      assert(both.join() === "n2,n2", "second player", both);
      return { keys: keys.map(([k, n]) => `${k} → ${n}`), both };
    },
  );
  await check(
    1,
    "core: Text view lists the path and navigates without motion",
    async () => {
      await s.run(() =>
        window.demoPlayers[0].goTo({ nodeId: "n1" }, { durationMs: 0 }),
      );
      await record();
      await s.click(button("Text view", "#player-1"));
      await s.waitFor(() => {
        const o = document.querySelector("#player-1 .xc-outline");
        return !!o && !o.hidden && o.getBoundingClientRect().height > 0;
      });
      const outline = await s.run(() =>
        [...document.querySelectorAll("#player-1 .xc-outline p")].map((p) =>
          p.textContent.trim(),
        ),
      );
      assert(
        outline.join("|") ===
          "XCursus|A different perspective|Connecting ideas",
        "outline text",
        outline,
      );
      await s.click(button("Conclusion", "#player-1 .xc-outline"));
      await settled(0, "n3");
      const { ms } = await lastDuration();
      assert(ms < 50, "the outline animated the camera, ms", ms);
      const focus = await s.run(() =>
        document.activeElement?.textContent?.trim(),
      );
      assert(focus === "Conclusion", "focus after choosing", focus);
      assert(
        await s.run(() =>
          [...document.querySelectorAll("#player-1 .xc-content")].every(
            (e) => e.getAttribute("aria-hidden") === "true",
          ),
        ),
        "3D content not hidden from assistive technology",
      );
      await shot("player-core-outline");
      await s.click('#player-1 button[aria-expanded="true"]');
      return { outline, transitionMs: ms };
    },
  );
  await check(1, "core: Reduce motion makes transitions instant", async () => {
    await s.run(() =>
      window.demoPlayers[0].goTo({ nodeId: "n1" }, { durationMs: 0 }),
    );
    await record();
    const next = button("Next", 'nav[aria-label="Player 1 controls"]');
    await s.click(next);
    await settled(0, "n2");
    const normal = (await lastDuration()).ms;
    // With "Reduce motion" on in the operating system the player is already
    // instant: the button then only keeps it so.
    const system = await s.run(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    await s.click(button("Reduce motion", "#player-1"));
    assert(
      (await s.run(() =>
        document
          .querySelector("#player-1 button[aria-pressed]")
          ?.getAttribute("aria-pressed"),
      )) === "true",
      "Reduce motion is not pressed",
    );
    await s.click(next);
    await settled(0, "n3");
    const reduced = (await lastDuration()).ms;
    if (system) assert(normal < 50, "system preference ignored, ms", normal);
    else assert(normal > 200, "normal transition too short, ms", normal);
    assert(reduced < 50, "reduced transition not instant, ms", reduced);
    await s.click('#player-1 button[aria-pressed="true"]');
    return {
      systemReducesMotion: system,
      normalMs: normal,
      reducedMs: reduced,
    };
  });

  await s.navigate(`${PLAYGROUND}/layout`);
  await s.waitFor(
    () =>
      window.demoPlayers?.length > 0 &&
      !!document.querySelector('.xc-scene[data-active="true"]'),
    { what: "the layout demo" },
  );
  await check(
    1,
    "layout: the first scene is framed; Next moves on",
    async () => {
      await s.run(() => document.fonts.ready.then(() => true));
      const box = await s.run(ACTIVE_BOX);
      assert(framed(box), "first scene not framed", box);
      await shot("player-layout-first");
      const first = await s.run(() => window.demoPlayers[0].getState().nodeId);
      await s.click(button("Next"));
      const moved = await s.waitFor(
        (n) => {
          const st = window.demoPlayers[0].getState();
          return st.nodeId !== n && !st.transition && st.nodeId;
        },
        { args: [first], what: "Next in the layout demo" },
      );
      return { first: box, from: first, to: moved };
    },
  );
}

// ---- 2. Studio -------------------------------------------------------------

async function studio() {
  const archive = staged(
    join(root, "examples/layout-canvas/layout-canvas.xcursus"),
  );
  let saved;
  await freshStudio();
  await check(2, "Studio opens the example archive", async () => {
    await openProject(archive, 3);
    const state = await s.run(() => ({
      title: window.studio.store.getSnapshot().document.metadata.title,
      warnings: document.querySelectorAll(".warning").length,
      missing:
        document
          .querySelector(".asset-panel")
          ?.textContent.includes("missing") ?? false,
    }));
    assert(
      state.warnings === 0 && !state.missing,
      "archive opened with",
      state,
    );
    return state;
  });
  await check(2, "a scene moved on the map, then undone", async () => {
    await s.click([
      () => document.querySelector('[aria-label="Scene list"] li button'),
    ]);
    const id = await s.run(() => window.studio.store.getSnapshot().selection);
    const position = (doc) => doc.scenes.find((x) => x.id === id).position;
    const before = position(await studioDoc()),
      steps = await history();
    const centre = await s.run((sceneId) => {
      const r = document
        .querySelector(`[data-map-scene="${sceneId}"] rect`)
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, id);
    await s.drag(centre, { x: centre.x + 55, y: centre.y + 30 }, 12);
    const moved = position(await studioDoc());
    assert((await history()) === steps + 1, "one history step per drag");
    assert(
      moved[0] > before[0] && moved[1] > before[1],
      "scene did not follow the pointer",
      { before, moved },
    );
    await s.click(button("Undo"));
    const undone = position(await studioDoc());
    assert(undone.join() === before.join(), "undo", { before, undone });
    return { sceneId: id, before, moved };
  });
  await check(2, "a block edited in the scene editor", async () => {
    await s.click(button("Layout"));
    const { sceneId, blockId, blocks } = await s.run(() => {
      const st = window.studio.store.getSnapshot();
      const scene = st.document.scenes.find((x) => x.id === st.selection);
      const ids = scene.blocks.map((b) => b.id);
      return {
        sceneId: scene.id,
        blockId: ids.includes("summary") ? "summary" : ids[0],
        blocks: ids.length,
      };
    });
    await s.waitFor(
      (n) => document.querySelectorAll("[data-layout-block]").length === n,
      { args: [blocks], what: "the scene editor overlay" },
    );
    const frame = async () =>
      (await studioDoc()).scenes
        .find((x) => x.id === sceneId)
        .blocks.find((b) => b.id === blockId).frame;
    const start = await frame(),
      steps = await history();
    const at = await s.run((b) => {
      const r = document
        .querySelector(`[data-layout-block="${b}"]`)
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width };
    }, blockId);
    const k = at.width / start.width;
    await s.drag(at, { x: at.x - 60, y: at.y - 48 }, 6);
    const moved = await frame();
    assert((await history()) === steps + 1, "one history step per drag");
    assert(
      Math.abs(moved.x - (start.x - 60 / k)) <= 1.5 &&
        Math.abs(moved.y - (start.y - 48 / k)) <= 1.5 &&
        moved.width === start.width,
      "block frame",
      { start, moved, k },
    );
    // The overlay and the block in the 3D preview coincide.
    const offset = await s.waitFor(
      (scene, block) => {
        const a = document
          .querySelector(`[data-layout-block="${block}"]`)
          .getBoundingClientRect();
        const b = document
          .querySelector(
            `.preview-player .xc-scene[data-scene-id="${scene}"] [data-block-id="${block}"]`,
          )
          .getBoundingClientRect();
        const worst = Math.max(
          ...[a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].map(
            Math.abs,
          ),
        );
        return worst <= 1 ? { worst } : null;
      },
      { args: [sceneId, blockId], what: "overlay aligned with the preview" },
    );
    await shot("studio-scene-editor");
    return { sceneId, blockId, start, moved, overlayOffsetPx: offset.worst };
  });
  await check(2, "Save archive, reload: no recovery offered", async () => {
    // The download is captured in the page (Safari would ask where to save).
    await s.run(() => {
      window.savedDownload = null;
      const blobs = new Map();
      const create = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        blobs.set(url, blob);
        return url;
      };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download || !blobs.has(this.href)) return click.call(this);
        const file = (window.savedDownload = { name: this.download });
        void blobs
          .get(this.href)
          .arrayBuffer()
          .then((buffer) => {
            const bytes = new Uint8Array(buffer);
            let text = "";
            for (let i = 0; i < bytes.length; i += 0x8000)
              text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            file.base64 = btoa(text);
          });
      };
    });
    await s.click(button("Save archive"));
    const file = await s.waitFor(
      () => window.savedDownload?.base64 && window.savedDownload,
      { what: "the archive bytes" },
    );
    await s.waitFor(() => window.studio.store.getSnapshot().dirty === false, {
      what: "a clean document",
    });
    const bytes = Buffer.from(file.base64, "base64");
    assert(file.name.endsWith(".xcursus"), "file name", file.name);
    assert(bytes.subarray(0, 2).toString() === "PK", "not a ZIP archive");
    saved = {
      path: join(stage, file.name),
      document: JSON.stringify(await studioDoc()),
    };
    await writeFile(saved.path, bytes);
    await delay(1000);
    await s.navigate(STUDIO_URL);
    await studioReady();
    await delay(2000);
    const offer = await s.run(NAMED, "button", "Recover revision", null);
    const dialog = await s.run(() => !!document.querySelector("dialog[open]"));
    assert(!offer && !dialog, "recovery offered after saving");
    return { name: file.name, bytes: bytes.length };
  });
  await check(2, "the saved archive reopens identical", async () => {
    assert(saved, "nothing saved");
    const scenes = JSON.parse(saved.document).scenes.length;
    await openProject(saved.path, scenes);
    await delay(500);
    const differences = diff(JSON.parse(saved.document), await studioDoc());
    assert(
      differences.length === 0,
      "differs from the saved document",
      differences,
    );
    return { scenes };
  });
}

// ---- 3. impress.js import --------------------------------------------------

async function impress() {
  const dir = join(root, "examples/impress-import");
  await freshStudio();
  await check(
    3,
    "impress.js import: review, then open the candidate",
    async () => {
      await s.click(button("Create the first scene"));
      await s.click(button("Import impress.js"));
      await s.waitFor(() => !!document.querySelector(".import-panel[open]"));
      await s.sendKeys(
        '.import-panel input[aria-label="impress.js HTML file"]',
        staged(join(dir, "deck.html")),
      );
      await s.sendKeys(
        '.import-panel input[aria-label="Images and media of the presentation"]',
        [
          staged(join(dir, "images/ring.png")),
          staged(join(dir, "images/axes.svg")),
        ].join("\n"),
      );
      await s.click(button("Convert", ".import-panel"));
      await s.waitFor(
        () =>
          document
            .querySelector(".import-panel")
            .textContent.includes("6 scenes, 6 on the path, 2 assets"),
        { what: "the conversion summary" },
      );
      const findings = await s.run(() =>
        [
          ...document.querySelectorAll(
            '.import-panel [aria-label="Findings"] li',
          ),
        ].map((li) => li.textContent.trim().replace(/\s+/g, " ")),
      );
      assert(findings.length > 0, "no findings listed");
      await shot("import-review");
      await s.click(button("Open candidate", ".import-panel"));
      // The new scene is unsaved work: Studio asks first.
      await s.waitFor(() => !!document.querySelector("dialog[open]"));
      if (await s.run(() => !document.querySelector(".import-panel[open]")))
        await s.click(button("Continue", "dialog[open]"));
      await s.waitFor(
        () =>
          document.querySelectorAll('[aria-label="Scene list"] li').length ===
          6,
        { what: "six scenes" },
      );
      const opened = await s.run(() => {
        const doc = window.studio.store.getSnapshot().document;
        return {
          title: doc.metadata.title,
          scenes: doc.scenes.map((x) => x.id),
          assets: doc.assets.map((a) => a.path),
        };
      });
      assert(
        opened.scenes.join() ===
          "welcome,beside,below,depth,sources,overview" &&
          opened.assets.join() === "images/ring.png,images/axes.svg",
        "candidate",
        opened,
      );
      const images = await s.waitFor(
        () => {
          const all = [...document.querySelectorAll(".preview-player img")];
          return all.length >= 2 &&
            all.every((i) => i.complete && i.naturalWidth > 0)
            ? all.map((i) => i.naturalWidth)
            : null;
        },
        { what: "both images rendered in the preview" },
      );
      await shot("import-opened");
      return { findings: findings.length, codes: findings, opened, images };
    },
  );
}

// ---- 4. Exported HTML ------------------------------------------------------

async function exported() {
  const html = exportDeck(stage);
  await s.navigate(pathToFileURL(html).href);
  await s.waitFor(() => document.documentElement.dataset.xcursus === "ready", {
    what: "the exported presentation",
  });
  await check(
    4,
    "exported HTML from file://: no remote request, formulas, images, theme font",
    async () => {
      const page = await s.run(async () => {
        await document.fonts.ready;
        const img = document.querySelector('[data-block-id="picture"] img');
        if (img && !img.complete) await img.decode().catch(() => {});
        const loaded = (family) =>
          [...document.fonts].some(
            (f) =>
              f.family.replace(/"/g, "") === family && f.status === "loaded",
          );
        return {
          url: location.protocol,
          remoteRequests: performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .filter((n) => /^(https?|wss?):/.test(n)),
          cspConnectNone:
            document
              .querySelector('meta[http-equiv="Content-Security-Policy"]')
              ?.content.includes("connect-src 'none'") ?? false,
          katex: document.querySelectorAll('[data-block-id="formula"] .katex')
            .length,
          katexFont: [...document.fonts].some(
            (f) => f.family.includes("KaTeX") && f.status === "loaded",
          ),
          imageWidth: img?.naturalWidth ?? 0,
          themeFont: loaded("XCursus Atkinson Hyperlegible"),
          headlineFont: getComputedStyle(
            document.querySelector('[data-block-id="headline"]'),
          ).fontFamily,
          payload: document.querySelector('[data-block-id="payload"]')
            ?.textContent,
          scriptInPayloadRan: window.pwned !== undefined,
        };
      });
      assert(page.url === "file:", "not opened from disk", page);
      assert(page.remoteRequests.length === 0, "remote requests", page);
      assert(page.cspConnectNone, "CSP", page);
      assert(page.katex === 1 && page.katexFont, "formula", page);
      assert(page.imageWidth > 0, "image", page);
      assert(
        page.themeFont &&
          page.headlineFont.includes("XCursus Atkinson Hyperlegible"),
        "theme font",
        page,
      );
      assert(
        page.payload ===
          "Literal text: </script><script>window.pwned=1</script> stays text." &&
          !page.scriptInPayloadRan,
        "payload",
        page,
      );
      const box = await s.run(ACTIVE_BOX);
      assert(framed(box), "first scene not framed", box);
      await shot("export-cover");
      return { ...page, frame: box };
    },
  );
  await check(4, "exported HTML: Previous, Next and the keyboard", async () => {
    const nav = 'nav[aria-label="Presentation navigation"]';
    const active = () =>
      s.run(
        () =>
          document.querySelector('.xc-scene[data-active="true"]')?.dataset
            .sceneId,
      );
    const at = (id) =>
      s.waitFor(
        (sceneId) =>
          document.querySelector('.xc-scene[data-active="true"]')?.dataset
            .sceneId === sceneId,
        { args: [id], what: `scene ${id}` },
      );
    const first = await active();
    await s.click(button("Next", nav));
    await at("context");
    const live = await s.run(() =>
      document.querySelector(".xc-live")?.textContent.trim(),
    );
    assert(live === "Flow scene with Markdown", "announcement", live);
    await s.click(button("Previous", nav));
    await at(first);
    assert(
      await s.run(
        (scope) =>
          [...document.querySelectorAll(`${scope} button`)].find(
            (b) => b.textContent.trim() === "Previous",
          ).disabled,
        nav,
      ),
      "Previous enabled at the start",
    );
    await s.run(() => document.querySelector("#xcursus-stage").focus());
    await s.press(Key.ArrowRight);
    await at("context");
    return { from: first, announcement: live };
  });
  await check(4, "exported HTML: Full screen enters and exits", async () => {
    const nav = 'nav[aria-label="Presentation navigation"]';
    await s.click(button("Full screen", nav));
    await s.waitFor(() => !!document.fullscreenElement, {
      what: "full screen",
    });
    await delay(1000);
    await shot("export-fullscreen");
    const label = await s.run(
      () =>
        [
          ...document.querySelectorAll(
            'nav[aria-label="Presentation navigation"] button',
          ),
        ].at(-1).textContent,
    );
    await s.click(button("Exit full screen", nav));
    await s.waitFor(() => !document.fullscreenElement, {
      what: "leaving full screen",
    });
    await delay(1000);
    return { labelInFullScreen: label };
  });
}

// ---- 5. Presenter ----------------------------------------------------------

async function presenter() {
  const deck = JSON.parse(
    readFileSync(
      join(root, "examples/structure-branching/project.json"),
      "utf8",
    ),
  );
  for (const scene of deck.scenes)
    scene.notes = `PRIVATE-NOTE ${scene.id}: say this only to yourself`;
  for (const edge of deck.paths[0].edges)
    if (edge.id === "BD" || edge.id === "CD")
      edge.condition = { kind: "visit-limit", maxVisits: 2 };
  const deckPath = join(stage, "presenter-deck.json");
  await writeFile(deckPath, JSON.stringify(deck));
  const consoleRegion = '[aria-label="Presenter view"]';
  const notes = () =>
    s.run(
      (scope) =>
        document
          .querySelector(`${scope} [aria-label="Speaker notes"]`)
          ?.textContent.trim() ?? "",
      consoleRegion,
    );

  await freshStudio();
  await check(
    5,
    "presenter: audience window, private notes, navigation in sync",
    async () => {
      await openProject(deckPath, deck.scenes.length);
      const main = await s.window();
      const before = await s.windows();
      await s.click(button("Presenter"));
      const audience = await newWindow(before);
      const publicNode = async () => {
        await s.switchTo(audience);
        const node = await s.run(
          () => window.publicPlayer?.getState().nodeId ?? null,
        );
        await s.switchTo(main);
        return node;
      };
      const publicAt = async (nodeId) => {
        for (let i = 0; i < 100; i++) {
          if ((await publicNode()) === nodeId) return;
          await delay(100);
        }
        throw new Error(`audience window not at ${nodeId}`);
      };
      await s.switchTo(audience);
      await s.waitFor(
        () => document.documentElement.dataset.presenter === "connected",
        { what: "the audience window connected" },
      );
      await s.switchTo(main);
      const status = await s.waitFor(
        (scope) =>
          document
            .querySelector(`${scope} [role="status"]`)
            ?.textContent.trim() === "Audience window connected" &&
          "Audience window connected",
        { args: [consoleRegion], what: "the console status" },
      );
      await publicAt("A");
      assert((await notes()).includes("PRIVATE-NOTE A"), "notes of A");
      // From the console.
      await s.click(
        button("Explore B", `${consoleRegion} [aria-label="Branch choices"]`),
      );
      await publicAt("B");
      assert((await notes()).includes("PRIVATE-NOTE B"), "notes of B");
      // From the audience window.
      await s.switchTo(audience);
      const leak = await s.run(
        () =>
          document.documentElement.outerHTML.includes("PRIVATE-NOTE") ||
          document.body.innerText.includes("PRIVATE-NOTE"),
      );
      await s.run(() => document.querySelector("#stage").focus());
      await s.press(Key.ArrowRight);
      await s.waitFor(() => window.publicPlayer.getState().nodeId === "D", {
        what: "the audience window at D",
      });
      await shot("presenter-audience");
      await s.switchTo(main);
      await s.waitFor(
        (scope) =>
          document
            .querySelector(`${scope} [aria-label="Speaker notes"]`)
            ?.textContent.includes("PRIVATE-NOTE D"),
        { args: [consoleRegion], what: "the console following the audience" },
      );
      assert(!leak, "notes in the audience window");
      await shot("presenter-console");
      await s.click(button("End", consoleRegion));
      for (const handle of await s.windows())
        if (handle !== main) {
          await s.switchTo(handle);
          await s.closeWindow();
        }
      await s.switchTo(main);
      return { status, path: ["A", "B (console)", "D (audience window)"] };
    },
  );
  await freshStudio();
  await check(
    5,
    "presenter: a blocked pop-up falls back to this tab",
    async () => {
      await openProject(deckPath, deck.scenes.length);
      await s.run(() => {
        window.open = () => null;
      });
      await s.click(button("Presenter"));
      const alert = await s.waitFor(
        (scope) => {
          const text = document
            .querySelector(`${scope} [role="alert"]`)
            ?.textContent.trim();
          return text?.includes("The browser blocked the audience window")
            ? text
            : null;
        },
        { args: [consoleRegion], what: "the blocked pop-up notice" },
      );
      await s.click(button("Present in this tab", consoleRegion));
      await s.waitFor(
        () =>
          !!document.querySelector('[aria-label="Presentation mode"]') &&
          document.querySelectorAll(".presentation-player .xc-player")
            .length === 1,
        { what: "the single-window presentation" },
      );
      const leak = await s.run(() =>
        document
          .querySelector(".presentation-player")
          .innerText.includes("PRIVATE-NOTE"),
      );
      assert(!leak, "notes in the presentation");
      await shot("presenter-single-window");
      await s.run(
        () => document.fullscreenElement && document.exitFullscreen(),
      );
      await s.press(Key.Escape);
      await delay(1000);
      return { alert };
    },
  );
}

// ---- 6. Touch -------------------------------------------------------------

/** Chrome on an Android device or emulator, through adb and DevTools. */
async function startAndroid() {
  const adb = process.env.ADB ?? "adb";
  const sh = (...a) => execFileSync(adb, a, { encoding: "utf8" }).trim();
  // Chrome reads its command line on a user build once it is the debug app:
  // no first-run screens.
  sh(
    "shell",
    "echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line",
  );
  sh("shell", "am", "set-debug-app", "--persistent", "com.android.chrome");
  sh("shell", "am", "force-stop", "com.android.chrome");
  // The device's localhost reaches the servers of this machine.
  for (const origin of [PLAYGROUND, STUDIO, DECK]) {
    const port = new URL(origin).port;
    sh("reverse", `tcp:${port}`, `tcp:${port}`);
  }
  sh(
    "shell",
    "am",
    "start",
    "-n",
    "com.android.chrome/com.google.android.apps.chrome.Main",
    "-d",
    "about:blank",
  );
  sh("forward", "tcp:9222", "localabstract:chrome_devtools_remote");
  const { chromium } = await import("@playwright/test");
  let connected;
  for (let i = 0; i < 60 && !connected; i++)
    try {
      connected = await chromium.connectOverCDP("http://127.0.0.1:9222");
    } catch {
      await delay(1000);
    }
  if (!connected) throw new Error("Chrome DevTools not reachable through adb");
  const context = connected.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p) => ({
        x: Math.round(p.x),
        y: Math.round(p.y),
      })),
    });
  const run = (fn, ...a) => page.evaluate(`(${fn})(...${JSON.stringify(a)})`);
  return {
    capabilities: {
      browserName: "chrome",
      browserVersion: connected.version(),
      platformName: "android",
      platformVersion: sh("shell", "getprop", "ro.build.version.release"),
      sdk: sh("shell", "getprop", "ro.build.version.sdk"),
      device: sh("shell", "getprop", "ro.product.model"),
    },
    navigate: (url) => page.goto(url, { waitUntil: "load" }),
    run,
    async waitFor(
      fn,
      { timeout = 10000, args: a = [], what = String(fn) } = {},
    ) {
      const end = Date.now() + timeout;
      let last;
      for (;;) {
        try {
          last = await run(fn, ...a);
          if (last) return last;
        } catch (error) {
          last = error;
        }
        if (Date.now() > end)
          throw new Error(`timed out waiting for ${what} (last: ${last})`);
        await delay(100);
      }
    },
    async tap(at) {
      await touch("touchStart", [at]);
      await delay(60);
      await touch("touchEnd", []);
    },
    async swipe(from, to, steps = 12) {
      await touch("touchStart", [from]);
      for (let i = 1; i <= steps; i++) {
        await delay(25);
        await touch("touchMove", [
          {
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
          },
        ]);
      }
      await touch("touchEnd", []);
    },
    screenshot: () => page.screenshot(),
    quit: async () => {
      await connected.close().catch(() => {});
    },
  };
}

/** Centre of the first element of `selector` named `name`, in the viewport. */
const CENTRE = (selector, name) => {
  const e = [...document.querySelectorAll(selector)].find(
    (x) => (x.getAttribute("aria-label") ?? x.textContent).trim() === name,
  );
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return {
    x: r.x + r.width / 2,
    y: r.y + r.height / 2,
    width: r.width,
    height: r.height,
  };
};
const centre = (selector, name) =>
  s.waitFor(CENTRE, { args: [selector, name], what: `${name}` });

async function touchChecks() {
  const tablet =
    browser === "ios-tablet" ||
    (browser === "android" &&
      (await s.run(() => Math.min(screen.width, screen.height) >= 600)));
  exportDeck();
  // A page that shows the deck in a 320 px wide frame.
  await writeFile(
    join(out, "narrow.html"),
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><iframe id="deck" src="deck.html" style="position:absolute;left:0;top:0;width:320px;height:568px;border:0"></iframe>',
  );
  const active = () =>
    s.run(
      () =>
        document.querySelector('.xc-scene[data-active="true"]')?.dataset
          .sceneId,
    );
  // A visit counts once its transition has ended: Previous is enabled.
  const at = (id) =>
    s.waitFor(
      (sceneId) => {
        const scene = document.querySelector('.xc-scene[data-active="true"]');
        const previous = [
          ...document.querySelectorAll(
            'nav[aria-label="Presentation navigation"] button',
          ),
        ].find((b) => b.textContent.trim() === "Previous");
        return (
          scene?.dataset.sceneId === sceneId &&
          (sceneId === "cover") === previous.disabled
        );
      },
      { args: [id], what: `scene ${id}` },
    );
  await s.navigate(`${DECK}/deck.html`);
  await s.waitFor(() => document.documentElement.dataset.xcursus === "ready", {
    what: "the exported presentation",
  });
  const view = await s.run(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
  }));
  await check(
    6,
    "exported HTML: swipes move to the next and previous visit",
    async () => {
      assert(view.maxTouchPoints > 0, "no touch input", view);
      // The input events the page receives, reported when a swipe fails.
      await s.run(() => {
        window.touchLog = [];
        for (const type of [
          "pointerdown",
          "pointerup",
          "pointercancel",
          "touchstart",
          "touchend",
          "touchcancel",
        ])
          document.addEventListener(
            type,
            (e) =>
              window.touchLog.push(
                `${type}:${e.pointerType ?? "touch"}@${Math.round(e.clientX ?? e.changedTouches?.[0]?.clientX ?? -1)}`,
              ),
            true,
          );
      });
      const swipeTo = async (from, to, sceneId) => {
        await s.swipe({ x: view.width * from, y }, { x: view.width * to, y });
        try {
          await at(sceneId);
        } catch (error) {
          const events = await s.run(() => window.touchLog);
          throw new Error(`${error.message}; events: ${events.join(" ")}`, {
            cause: error,
          });
        }
      };
      const first = await active();
      const y = view.height / 2;
      await swipeTo(0.8, 0.2, "context");
      await shot("touch-after-swipe");
      await swipeTo(0.2, 0.8, first);
      return { viewport: view, from: first, to: "context" };
    },
  );
  await check(
    6,
    "exported HTML: buttons are at least 44 px and respond to taps",
    async () => {
      const sizes = await s.run(() =>
        [
          ...document.querySelectorAll(
            'nav[aria-label="Presentation navigation"] button',
          ),
        ].map((b) => {
          const r = b.getBoundingClientRect();
          return {
            name: b.textContent.trim(),
            width: r.width,
            height: r.height,
          };
        }),
      );
      assert(
        sizes.length >= 2 &&
          sizes.every((b) => b.width >= 44 && b.height >= 44),
        "button sizes",
        sizes,
      );
      const first = await active();
      // A tap right after a fast swipe only stops the fling (no click).
      await delay(2500);
      await s.tap(
        await centre(
          'nav[aria-label="Presentation navigation"] button',
          "Next",
        ),
      );
      await at("context");
      await s.tap(
        await centre(
          'nav[aria-label="Presentation navigation"] button',
          "Previous",
        ),
      );
      await at(first);
      return { buttons: sizes };
    },
  );
  await check(6, "the outline is readable at 320 px width", async () => {
    await s.navigate(`${DECK}/narrow.html`);
    await s.waitFor(
      () =>
        document.querySelector("#deck").contentDocument?.documentElement.dataset
          .xcursus === "ready",
      { what: "the deck in the frame" },
    );
    // The frame sits at the top left corner: its coordinates are the page's.
    const toggle = await s.run(() => {
      const doc = document.querySelector("#deck").contentDocument;
      const b = [...doc.querySelectorAll("button")].find(
        (x) => x.textContent.trim() === "Text view",
      );
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await s.tap(toggle);
    const outline = await s.waitFor(
      () => {
        const doc = document.querySelector("#deck").contentDocument;
        const o = doc.querySelector(".xc-outline");
        if (!o || o.hidden || !o.getBoundingClientRect().height) return null;
        const text = [...o.querySelectorAll("p, button")];
        return {
          frameWidth: doc.documentElement.clientWidth,
          pageOverflow:
            doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
          outlineOverflow: o.scrollWidth - o.clientWidth,
          items: o.querySelectorAll("li").length,
          // Scrolled to the end, no text stays under the on-screen buttons.
          hiddenUnderButtons: (() => {
            o.scrollTop = o.scrollHeight;
            const buttons = [
              ...doc.querySelectorAll(
                'nav[aria-label="Presentation navigation"] button',
              ),
            ].map((b) => b.getBoundingClientRect());
            return text.filter((e) => {
              const r = e.getBoundingClientRect();
              return buttons.some(
                (b) =>
                  r.left < b.right &&
                  r.right > b.left &&
                  r.top < b.bottom &&
                  r.bottom > b.top,
              );
            }).length;
          })(),
          smallestFontPx: Math.min(
            ...text.map((e) => parseFloat(getComputedStyle(e).fontSize)),
          ),
          clipped: text.filter(
            (e) =>
              e.getBoundingClientRect().right >
              doc.documentElement.clientWidth + 1,
          ).length,
        };
      },
      { what: "the outline in the frame" },
    );
    await shot("touch-outline-320");
    assert(
      outline.frameWidth === 320 &&
        outline.pageOverflow <= 1 &&
        outline.outlineOverflow <= 1 &&
        outline.clipped === 0 &&
        outline.hiddenUnderButtons === 0 &&
        outline.items > 0 &&
        outline.smallestFontPx >= 16,
      "outline at 320 px",
      outline,
    );
    return outline;
  });
  if (!tablet) return;
  await check(6, "tablet: Studio opens a project and presents it", async () => {
    await s.navigate(STUDIO_URL);
    await s.waitFor(
      () =>
        !!window.studio?.store &&
        !!document.querySelector(".preview-player .xc-player"),
      { timeout: 30000, what: "Studio" },
    );
    const json = readFileSync(
      join(root, "examples/core-three-scenes/project.json"),
      "utf8",
    );
    await s.run(
      (selector, text) => {
        const input = document.querySelector(selector);
        const data = new DataTransfer();
        data.items.add(
          new File([text], "project.json", { type: "application/json" }),
        );
        input.files = data.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      PROJECT_INPUT,
      json,
    );
    await s.waitFor(
      () => window.studio.store.getSnapshot().document.scenes.length === 3,
      { what: "three scenes in Studio" },
    );
    await s.tap(await centre("button", "Present"));
    await s.waitFor(
      () =>
        !!document.querySelector('[aria-label="Presentation mode"]') &&
        !!window.studio.presentation,
      { what: "the presentation" },
    );
    const first = await s.waitFor(
      () => window.studio.presentation.getState().nodeId,
      { what: "the presented node" },
    );
    await s.tap(await centre("button", "Next scene"));
    const next = await s.waitFor(
      (n) => {
        const state = window.studio.presentation.getState();
        return state.nodeId !== n && !state.transition && state.nodeId;
      },
      { args: [first], what: "the next scene" },
    );
    await shot("touch-studio-present");
    return { from: first, to: next };
  });
}

// ---- run -------------------------------------------------------------------

const sh = (command, argv) => {
  try {
    return execFileSync(command, argv, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
function environment(caps) {
  const common = {
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    runner: process.env.RUNNER_NAME
      ? `${process.env.ImageOS ?? ""} ${process.env.ImageVersion ?? ""}`.trim()
      : null,
  };
  if (browser === "safari")
    return {
      browser: `Safari ${caps.browserVersion}`,
      build: sh("defaults", [
        "read",
        "/Applications/Safari.app/Contents/Info.plist",
        "CFBundleVersion",
      ]),
      platform: `macOS ${caps["safari:platformVersion"]} (${caps["safari:platformBuildVersion"]})`,
      driver: sh("/usr/bin/safaridriver", ["--version"]),
      ...common,
    };
  if (browser.startsWith("ios"))
    return {
      browser: `Safari ${caps.browserVersion}`,
      platform:
        `iOS Simulator ${caps["safari:platformVersion"] ?? caps.platformVersion ?? ""}`.trim(),
      device: caps["safari:deviceName"] ?? caps["safari:deviceType"],
      driver: sh("/usr/bin/safaridriver", ["--version"]),
      ...common,
    };
  if (browser === "firefox")
    return {
      browser: `Firefox ${caps.browserVersion}`,
      build: caps["moz:buildID"] ?? null,
      platform:
        `${caps.platformName} ${caps["moz:platformVersion"] ?? ""}`.trim(),
      driver: sh(process.env.GECKODRIVER ?? "geckodriver", [
        "--version",
      ])?.split("\n")[0],
      ...common,
    };
  return {
    browser: `Chrome ${caps.browserVersion}`,
    platform: `Android ${caps.platformVersion} (API ${caps.sdk})`,
    device: caps.device,
    ...common,
  };
}

await mkdir(out, { recursive: true });
await mkdir(stage, { recursive: true });
for (const name of await readdir(out))
  if (name.startsWith("failure-")) await rm(join(out, name));
const servers = [
  await preview("@xcursus/playground", PLAYGROUND, root),
  await preview("@xcursus/studio", STUDIO, root),
  touchTarget ? await serveDir(out, DECK) : undefined,
].filter(Boolean);
const started = new Date();
try {
  s =
    browser === "android" ? await startAndroid() : await startBrowser(browser);
  if (!touchTarget)
    await s
      .setWindowRect({ x: 0, y: 0, width: 1440, height: 1000 })
      .catch(() => {});
  console.log(
    Object.values(environment(s.capabilities)).slice(0, 2).join(" · "),
  );
  const items = touchTarget
    ? [[6, touchChecks]]
    : [
        [1, player],
        [2, studio],
        [3, impress],
        [4, exported],
        [5, presenter],
      ];
  for (const [item, run] of items)
    if (!only || only.has(item)) {
      try {
        await run();
      } catch (error) {
        results.push({ item, name: "setup", ok: false, error: error.message });
        console.log(`  FAIL ${item}. setup\n       ${error.message}`);
      }
    }
} finally {
  await s?.quit().catch(() => {});
  for (const server of servers) server.kill();
}
const report = {
  date: started.toISOString(),
  target: browser,
  environment: environment(s?.capabilities ?? {}),
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
const version = (s?.capabilities?.browserVersion ?? "unknown").split(" ")[0];
const file = join(out, `${browser}-${version}.json`);
await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `${report.passed} passed, ${report.failed} failed · ${file.slice(root.length)}`,
);
process.exit(report.failed || !report.passed ? 1 : 0);
