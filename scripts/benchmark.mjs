import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, platform, release, totalmem, type, arch } from "node:os";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

// Performance budgets of the specification (section 12), measured on the
// production builds (run `pnpm build` first). Reference scenario: 100 scenes
// with 10 text blocks of 100 characters, a 100-node path, no media, a
// 1280×720 viewport at DPR 1; five warm-ups and twenty measurements per
// metric, p50 and p95 reported with the raw samples and the environment.
//
//   node scripts/benchmark.mjs [--browser chromium|firefox|webkit] [--headed] [--gate]
//
// Results go to test-results/benchmark/. Timings on a shared or uncontrolled
// machine are informative; --gate exits non-zero when a budget is exceeded.
const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const browserName = option("--browser", "chromium");
const headed = args.includes("--headed");
const gate = args.includes("--gate");
const WARMUP = 5,
  RUNS = 20;

// Playwright: the macOS 14 WebKit build needs the dedicated 1.61.1 runner.
const macos14 = platform() === "darwin" && release().startsWith("23.");
const require = createRequire(
  browserName === "webkit" && macos14
    ? join(root, "tools/webkit-macos14/package.json")
    : import.meta.url,
);
const playwright = require("@playwright/test");
const playwrightVersion = require("@playwright/test/package.json").version;

/** The reference document, generated deterministically. */
function referenceDocument() {
  const words =
    "spatial scenes camera path branch outline layout canvas theme token";
  const text = (i, j) =>
    `${i}.${j} ${words}`.repeat(4).slice(0, 100).padEnd(100, ".");
  const scenes = Array.from({ length: 100 }, (_, i) => ({
    id: `s${i}`,
    title: `Scene ${i + 1}`,
    position: [(i % 10) * 1400, Math.floor(i / 10) * 900, 0],
    rotation: [0, 0, (i % 7) * 3],
    scale: 1,
    size: [1200, 760],
    visible: true,
    blocks: Array.from({ length: 10 }, (_, j) => ({
      id: `b${j}`,
      type: "text",
      data: { text: text(i, j) },
    })),
    notes: "",
    extensions: {},
    parentId: null,
    layout: "flow",
    appearance: { variant: "card", background: null, titleVisible: true },
  }));
  return {
    schemaVersion: "1.3.0",
    id: "benchmark",
    metadata: { title: "Benchmark", language: "en" },
    settings: {
      viewport: { width: 1280, height: 720, perspective: 1000 },
      presentation: {
        fit: "contain",
        motion: "system",
        defaultTransition: { durationMs: 700, easing: "ease-in-out" },
      },
    },
    requiredCapabilities: ["linear"],
    scenes,
    assets: [],
    paths: [
      {
        id: "main",
        name: "Main",
        startNodeId: "n0",
        nodes: scenes.map((s, i) => ({
          id: `n${i}`,
          sceneId: s.id,
          holdMs: 0,
        })),
        edges: scenes.slice(1).map((_, i) => ({
          id: `e${i}`,
          from: `n${i}`,
          to: `n${i + 1}`,
          label: "",
          transition: { durationMs: 700, easing: "ease-in-out" },
        })),
      },
    ],
    defaultPathId: "main",
    extensions: {},
    cameraTracks: [],
    cues: [],
    theme: {
      palette: [
        { id: "text", value: "#172035" },
        { id: "background", value: "#ffffff" },
        { id: "accent", value: "#215baf" },
        { id: "backdrop", value: "#e8edf4" },
      ],
      colors: {
        text: "text",
        background: "background",
        accent: "accent",
        backdrop: "backdrop",
      },
      fonts: { body: "system-sans", heading: "system-sans" },
      typeScale: { body: 28, title: 46 },
    },
  };
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
};
const stats = (samples) => ({
  n: samples.length,
  p50: percentile(samples, 50),
  p95: percentile(samples, 95),
  max: Math.max(...samples),
  samples: samples.map((v) => Math.round(v * 1000) / 1000),
});

/** Static server for a production build, with the single-page fallback. */
function serve(dir) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
  };
  const server = createServer((request, response) => {
    const path = normalize(
      decodeURIComponent(new URL(request.url, "http://x").pathname),
    );
    let file = join(dir, path);
    if (
      !file.startsWith(dir) ||
      !existsSync(file) ||
      statSync(file).isDirectory()
    )
      file = join(dir, "index.html");
    response.setHeader(
      "content-type",
      types[extname(file)] ?? "application/octet-stream",
    );
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}

function environment(browser) {
  const sh = (command, argv) => {
    try {
      return execFileSync(command, argv, { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return {
    date: new Date().toISOString(),
    os: `${type()} ${release()} (${platform()} ${arch()})`,
    osVersion:
      platform() === "darwin" ? sh("sw_vers", ["-productVersion"]) : null,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    power:
      platform() === "darwin"
        ? (sh("pmset", ["-g", "batt"])?.split("\n")[0] ?? null)
        : null,
    node: process.version,
    playwright: playwrightVersion,
    browser: `${browserName} ${browser.version()}`,
    headless: !headed,
    viewport: "1280x720",
    deviceScaleFactor: 1,
    lockfileSha256: createHash("sha256")
      .update(readFileSync(join(root, "pnpm-lock.yaml")))
      .digest("hex"),
    commit: sh("git", ["rev-parse", "HEAD"]),
    workingTreeClean:
      sh("git", ["status", "--porcelain", "--untracked-files=no"]) === "",
    warmup: WARMUP,
    runs: RUNS,
  };
}

const document = referenceDocument();
const results = { metrics: {}, gates: {} };

// Validation: the core of the production build, in Node.
{
  const core = await import(
    pathToFileURL(join(root, "packages/core/dist/index.js")).href
  );
  const json = JSON.stringify(document);
  if (!core.validateDocument(json).ok)
    throw new Error("Reference document is invalid");
  const samples = [];
  for (let i = 0; i < WARMUP + RUNS; i++) {
    const start = performance.now();
    core.validateDocument(json);
    if (i >= WARMUP) samples.push(performance.now() - start);
  }
  results.metrics.validateMs = {
    where: `Node ${process.version}`,
    ...stats(samples),
  };
}

const playground = await serve(join(root, "apps/playground/dist"));
const studio = await serve(join(root, "apps/studio/dist"));
const browser = await playwright[browserName].launch({ headless: !headed });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.goto(`${playground.url}/core`);
  await page.waitForFunction(
    () => typeof window.createDemoPlayer === "function",
  );
  await page.evaluate(() => {
    const host = window.document.createElement("div");
    host.id = "bench";
    host.style.cssText =
      "position:fixed;left:0;top:0;width:1280px;height:720px;z-index:10";
    window.document.body.append(host);
  });

  // Mount until ready, a fresh player each time.
  results.metrics.mountReadyMs = stats(
    await page.evaluate(
      async ([doc, warmup, runs]) => {
        const host = window.document.getElementById("bench");
        const samples = [];
        for (let i = 0; i < warmup + runs; i++) {
          const player = window.createDemoPlayer();
          const start = performance.now();
          const result = await player.mount(host, doc);
          const elapsed = performance.now() - start;
          if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
          player.destroy();
          if (i >= warmup) samples.push(elapsed);
          await new Promise((r) => setTimeout(r, 50));
        }
        return samples;
      },
      [document, WARMUP, RUNS],
    ),
  );

  // Camera: frame intervals and long tasks during 10 transitions.
  const camera = await page.evaluate(async (doc) => {
    const host = window.document.getElementById("bench");
    const long = [];
    // Only engines that list the entry type report long tasks at all.
    const supported =
      PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false;
    const observer = supported
      ? new PerformanceObserver((list) =>
          long.push(...list.getEntries().map((e) => e.duration)),
        )
      : undefined;
    observer?.observe({ type: "longtask", buffered: false });
    const player = window.createDemoPlayer();
    await player.mount(host, doc);
    const intervals = [];
    let last = performance.now(),
      running = true;
    const tick = (t) => {
      intervals.push(t - last);
      last = t;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame((t) => {
      last = t;
      requestAnimationFrame(tick);
    });
    for (let i = 0; i < 10; i++) {
      const r = await player.next();
      if (r.status !== "completed") throw new Error(JSON.stringify(r));
    }
    running = false;
    observer?.disconnect();
    player.destroy();
    return {
      intervals: intervals.slice(1),
      longTasks: long,
      longTaskObserved: !!observer,
    };
  }, document);
  results.metrics.cameraFrameIntervalMs = stats(camera.intervals);
  results.metrics.longTasksMs = {
    observed: camera.longTaskObserved,
    count: camera.longTasks.length,
    max: camera.longTasks.length ? Math.max(...camera.longTasks) : 0,
    samples: camera.longTasks,
  };

  // Teardown: 50 mount/destroy cycles, owned resources and heap after GC.
  const cdp =
    browserName === "chromium" ? await context.newCDPSession(page) : null;
  const heap = async () => {
    if (!cdp) return null;
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Runtime.getHeapUsage")).usedSize;
  };
  await page.evaluate(async (doc) => {
    // One warm-up cycle loads every module before the baseline.
    const p = window.createDemoPlayer();
    await p.mount(window.document.getElementById("bench"), doc);
    p.destroy();
  }, document);
  const before = await heap();
  const owned = await page.evaluate(async (doc) => {
    const host = window.document.getElementById("bench");
    const pending = new Set();
    let next = 1;
    const clock = {
      now: () => performance.now(),
      request(callback) {
        const id = next++;
        pending.add(id);
        requestAnimationFrame((t) => {
          if (pending.delete(id)) callback(t);
        });
        return id;
      },
      cancel(id) {
        pending.delete(id);
      },
    };
    const urls = { created: 0, revoked: 0 };
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => (urls.created++, create(b));
    URL.revokeObjectURL = (u) => (urls.revoked++, revoke(u));
    const leftovers = [];
    for (let i = 0; i < 50; i++) {
      const player = window.createDemoPlayer({ clock });
      await player.mount(host, doc);
      void player.next();
      await new Promise((r) => requestAnimationFrame(r));
      player.destroy();
      leftovers.push({
        children: host.childElementCount,
        pendingFrames: pending.size,
        tabindex: host.getAttribute("tabindex"),
      });
    }
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    return { leftovers, urls };
  }, document);
  const after = await heap();
  results.metrics.teardown = {
    cycles: 50,
    leftoverChildren: Math.max(...owned.leftovers.map((l) => l.children)),
    leftoverFrames: Math.max(...owned.leftovers.map((l) => l.pendingFrames)),
    hostAttributesRestored: owned.leftovers.every((l) => l.tabindex === null),
    blobUrls: owned.urls,
    heapBeforeBytes: before,
    heapAfterBytes: after,
    heapDeltaMiB: before === null ? null : (after - before) / 2 ** 20,
  };

  // Studio: inspector edit → preview commit, on the same document.
  const editor = await context.newPage();
  await editor.goto(`${studio.url}/?studio-debug`);
  await editor.waitForFunction(() => !!window.studio?.preview);
  await editor.getByLabel("JSON project file").setInputFiles({
    name: "benchmark.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await editor.waitForFunction(
    () => window.studio.store.getSnapshot().document.scenes.length === 100,
  );
  await editor
    .getByRole("list", { name: "Scene list" })
    .getByRole("button")
    .nth(50)
    .click();
  await editor.evaluate(() => {
    const marks = { inputs: [], commits: [] };
    window.benchMarks = marks;
    window.studio.preview.on("documentchange", () =>
      marks.commits.push(performance.now()),
    );
    window.document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter") marks.inputs.push(performance.now());
      },
      true,
    );
  });
  const x = editor.getByRole("textbox", { name: "X", exact: true });
  for (let i = 0; i < WARMUP + RUNS; i++) {
    await x.fill(String(7000 + i * 7));
    await x.press("Enter");
    await editor.waitForTimeout(60);
  }
  const marks = await editor.evaluate(() => window.benchMarks);
  const latency = marks.inputs
    .map((t) => {
      const c = marks.commits.find((v) => v >= t);
      return c === undefined ? Infinity : c - t;
    })
    .slice(WARMUP);
  results.metrics.inputToPreviewMs = stats(latency);
  results.environment = environment(browser);
} finally {
  await browser.close();
  await playground.close();
  await studio.close();
}

const m = results.metrics;
results.gates = {
  "validate p95 <= 100 ms": m.validateMs.p95 <= 100,
  "mount-ready p95 <= 1000 ms": m.mountReadyMs.p95 <= 1000,
  "input -> preview p95 <= 100 ms": m.inputToPreviewMs.p95 <= 100,
  "frame interval p95 <= 34 ms": m.cameraFrameIntervalMs.p95 <= 34,
  "no long task > 200 ms": m.longTasksMs.observed
    ? m.longTasksMs.max <= 200
    : "not observable in this engine",
  "teardown: zero owned resources":
    m.teardown.leftoverChildren === 0 &&
    m.teardown.leftoverFrames === 0 &&
    m.teardown.hostAttributesRestored &&
    m.teardown.blobUrls.created === m.teardown.blobUrls.revoked,
  "heap delta <= 5 MiB after GC":
    m.teardown.heapDeltaMiB === null
      ? "not measurable in this engine"
      : m.teardown.heapDeltaMiB <= 5,
};
const out = join(root, "test-results", "benchmark");
await mkdir(out, { recursive: true });
const file = join(
  out,
  `benchmark-${browserName}${headed ? "-headed" : ""}.json`,
);
await writeFile(file, JSON.stringify(results, null, 2) + "\n");
const round = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);
console.log(
  JSON.stringify(
    {
      browser: results.environment.browser,
      headless: results.environment.headless,
      power: results.environment.power,
      validate: [round(m.validateMs.p50), round(m.validateMs.p95)],
      mountReady: [round(m.mountReadyMs.p50), round(m.mountReadyMs.p95)],
      inputToPreview: [
        round(m.inputToPreviewMs.p50),
        round(m.inputToPreviewMs.p95),
      ],
      frameInterval: [
        round(m.cameraFrameIntervalMs.p50),
        round(m.cameraFrameIntervalMs.p95),
      ],
      longTasks: m.longTasksMs.observed
        ? [m.longTasksMs.count, round(m.longTasksMs.max)]
        : "n/a",
      heapDeltaMiB: round(m.teardown.heapDeltaMiB),
      gates: results.gates,
      file,
    },
    null,
    2,
  ),
);
if (gate && Object.values(results.gates).some((v) => v === false))
  process.exitCode = 1;
