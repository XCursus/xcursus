import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./runner.js";
import { evidencePath, studioURL, writeEvidence } from "./evidence.js";
import type {
  Player,
  PlayerMessages,
  PlayerOptions,
} from "../../packages/player/src/index.js";
import type { RendererRegistry } from "../../packages/player/src/index.js";
import type { ProjectDocument } from "../../packages/core/src/index.js";
import fixture from "../../examples/editor-roundtrip/project.json" with { type: "json" };
declare global {
  interface Window {
    demoPlayers: Player[];
    createDemoPlayer: (options?: PlayerOptions) => Player;
    demoDocument: ProjectDocument;
    contentRegistry: RendererRegistry;
    contentBlobs: Map<string, Blob>;
    perf?: { digests: number; urls: number };
    heldDatabase?: IDBDatabase;
  }
}
async function remoteHosts(context: BrowserContext) {
  // Non-localhost HTTP origins are not secure contexts: crypto.subtle is absent.
  await context.route(
    /^http:\/\/(gallery|studio)\.xcursus\.test\//,
    async (route) => {
      const url = new URL(route.request().url());
      const port = url.hostname.startsWith("gallery") ? 4173 : 4174;
      const response = await route.fetch({
        url: `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        headers: { ...route.request().headers(), host: `127.0.0.1:${port}` },
      });
      await route.fulfill({ response });
    },
  );
}
async function loadedGallery(page: Page) {
  await expect(page.locator(".xc-player")).toHaveCount(2);
  await expect(
    page
      .locator('.xc-block [role="status"]')
      .filter({ hasText: "Loading local resource" }),
  ).toHaveCount(0);
}
test("assets with digests load over HTTP on a non-localhost host: gallery, archive and Studio preview", async ({
  page,
  context,
}) => {
  await remoteHosts(context);
  await page.goto("http://gallery.xcursus.test/content");
  await loadedGallery(page);
  expect(
    await page.evaluate(() => ({
      secure: window.isSecureContext,
      subtle: typeof globalThis.crypto.subtle,
    })),
  ).toEqual({ secure: false, subtle: "undefined" });
  await page.evaluate(() =>
    window.demoPlayers[0]!.goTo({ nodeId: "image" }, { durationMs: 0 }),
  );
  await expect
    .poll(() =>
      page
        .locator('#player-1 [data-block-type="image"] img')
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const video = page.locator('#player-1 [data-block-type="video"] video');
  await expect(video).toHaveAttribute("playsinline", "");
  await expect(video.locator("track")).toHaveCount(1);
  await expect(page.locator("#player-1 .xc-world")).not.toContainText(
    /digest|signature|Missing resource/,
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download gallery archive" }).click();
  const archive = await readFile((await (await download).path())!);
  const studio = await context.newPage();
  await studio.goto("http://studio.xcursus.test/?studio-debug");
  await expect(studio.locator(".preview-player .xc-player")).toHaveCount(1);
  await studio.getByLabel("JSON project file").setInputFiles({
    name: "gallery.xcursus",
    mimeType: "application/zip",
    buffer: archive,
  });
  await expect(
    studio.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(11);
  await studio
    .getByRole("list", { name: "Scene list" })
    .getByRole("button")
    .nth(5)
    .click();
  await expect
    .poll(() =>
      studio
        .locator('.preview-player [data-block-type="image"] img')
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await studio
    .getByLabel("Add local resource")
    .setInputFiles("examples/content-gallery/assets/captions.vtt");
  await expect(studio.locator(".asset-panel li")).toHaveCount(5);
  await expect(studio.locator(".asset-panel li").last()).toContainText(
    "available",
  );
  await expect(studio.locator(".asset-panel [role=alert]")).toHaveCount(0);
});
async function heavyFixtures() {
  const video = "test-results/fixtures/heavy-50mib.mp4",
    image = "test-results/fixtures/heavy-image.svg";
  try {
    await stat(video);
    await stat(image);
    return { video, image };
  } catch {
    /* Build below. */
  }
  await mkdir(dirname(video), { recursive: true });
  const base = await readFile("examples/content-gallery/assets/motion.mp4");
  // A trailing top-level `free` box keeps the MP4 structurally valid.
  const padding = 50 * 1024 * 1024 - 4096 - base.length;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(padding);
  header.write("free", 4, "ascii");
  await writeFile(
    video,
    Buffer.concat([base, header, Buffer.alloc(padding - 8, 7)]),
  );
  const rects = Array.from(
    { length: 30000 },
    (_, i) =>
      `<rect x="${i % 300}" y="${Math.floor(i / 300)}" width="1" height="1" fill="#${((i * 2654435761) % 0xffffff).toString(16).padStart(6, "0")}"/>`,
  ).join("");
  await writeFile(
    image,
    // No prolog: the same fixture must load on 0.4 for the before/after measure.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">${rects}</svg>`,
  );
  return { video, image };
}
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;
};
test("Studio preview with 50 MiB of media stays incremental: no digests or URLs per edit, p95 input→preview recorded", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(600_000);
  const files = await heavyFixtures();
  await page.addInitScript(() => {
    window.perf = { digests: 0, urls: 0 };
    const subtle = globalThis.crypto.subtle;
    if (subtle) {
      const digest = subtle.digest.bind(subtle);
      subtle.digest = (...args: Parameters<SubtleCrypto["digest"]>) => {
        window.perf!.digests++;
        return digest(...args);
      };
    }
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      window.perf!.urls++;
      return create(object);
    };
  });
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "New scene", exact: true }).click();
  for (const file of [
    files.image,
    "examples/content-gallery/assets/diagram.svg",
    files.video,
  ]) {
    const count = await page.locator(".asset-panel li").count();
    await page.getByLabel("Add local resource").setInputFiles(file);
    await expect(page.locator(".asset-panel li")).toHaveCount(count + 1, {
      timeout: 60_000,
    });
  }
  await page
    .getByRole("list", { name: "Scene list" })
    .getByRole("button")
    .first()
    .click();
  for (const type of ["image", "video"]) {
    await page.getByLabel("Block type").selectOption(type);
    await page.getByRole("button", { name: "Add block" }).click();
  }
  const previewVideo = page.locator(
    '.preview-player [data-block-type="video"] video',
  );
  await expect(previewVideo).toHaveCount(1, { timeout: 60_000 });
  await expect
    .poll(
      () => previewVideo.evaluate((v) => (v as HTMLVideoElement).readyState),
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page
        .locator('.preview-player [data-block-type="image"] img')
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    window.perf = { digests: 0, urls: 0 };
    const marks = { inputs: [] as number[], commits: [] as number[] };
    (window as unknown as { marks: typeof marks }).marks = marks;
    window.studio!.preview!.on("documentchange", () =>
      marks.commits.push(performance.now()),
    );
    // performance.now() at dispatch: WebKit stamps synthesized pointer events on another clock.
    const record = () => marks.inputs.push(performance.now());
    document.addEventListener(
      "keydown",
      (e) => {
        if ((e as KeyboardEvent).key === "Enter") record();
      },
      true,
    );
    document.addEventListener("pointermove", record, true);
  });
  const videoElement = await previewVideo.elementHandle();
  const tracing = info.project.name === "chromium";
  if (tracing)
    await browser.startTracing(page, {
      path: evidencePath(`perf-trace-${info.project.name}.json`),
      screenshots: false,
    });
  const x = page.getByRole("textbox", { name: "X", exact: true });
  for (let i = 0; i < 100; i++) {
    await x.fill(String(1000 + i * 3));
    await x.press("Enter");
  }
  await page.waitForTimeout(100);
  const inspector = await page.evaluate(() => {
    const m = (
      window as unknown as { marks: { inputs: number[]; commits: number[] } }
    ).marks;
    const result = { inputs: [...m.inputs], commits: [...m.commits] };
    m.inputs.length = 0;
    m.commits.length = 0;
    return result;
  });
  const sceneId = await page.evaluate(
    () => window.studio!.store.getSnapshot().selection,
  );
  const rect = page.locator(`[data-map-scene="${sceneId}"]`).first();
  const box = (await rect.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 100; i++) {
    await page.mouse.move(
      box.x + box.width / 2 + i,
      box.y + box.height / 2 + (i % 7),
    );
    await page.evaluate(
      () =>
        new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    );
  }
  await page.mouse.up();
  await page.waitForTimeout(100);
  if (tracing) await browser.stopTracing();
  const drag = await page.evaluate(() => {
    const m = (
      window as unknown as { marks: { inputs: number[]; commits: number[] } }
    ).marks;
    return { inputs: [...m.inputs], commits: [...m.commits] };
  });
  const latencies = (series: { inputs: number[]; commits: number[] }) =>
    series.inputs
      .map((t) => series.commits.find((c) => c >= t))
      .map((c, i) => (c === undefined ? Infinity : c - series.inputs[i]!));
  const editLatency = latencies(inspector),
    dragLatency = latencies(drag);
  const counters = await page.evaluate(() => window.perf!);
  const stillSame = await page.evaluate(
    (v) =>
      v ===
      document.querySelector('.preview-player [data-block-type="video"] video'),
    videoElement,
  );
  const summary = {
    browser: info.project.name,
    browserVersion: browser.version(),
    runner: process.env.XCURSUS_E2E_RUNNER,
    ci: !!process.env.CI,
    media: {
      videoBytes: (await stat(files.video)).size,
      imageBytes: (await stat(files.image)).size,
    },
    inspector: {
      samples: editLatency.length,
      p50: percentile(editLatency, 50),
      p95: percentile(editLatency, 95),
      max: Math.max(...editLatency),
    },
    drag: {
      samples: dragLatency.length,
      p50: percentile(dragLatency, 50),
      p95: percentile(dragLatency, 95),
      max: Math.max(...dragLatency),
    },
    counters,
    videoElementPreserved: stillSame,
    trace: tracing ? `perf-trace-${info.project.name}.json` : null,
  };
  await writeEvidence(`perf-${info.project.name}.json`, summary);
  expect(editLatency.length).toBeGreaterThanOrEqual(100);
  expect(dragLatency.length).toBeGreaterThanOrEqual(50);
  expect(counters).toEqual({ digests: 0, urls: 0 });
  expect(stillSame).toBe(true);
  // Timing is a gate on the declared local runner and informative on noisy CI.
  if (!process.env.CI) {
    expect(summary.inspector.p95).toBeLessThanOrEqual(100);
    expect(summary.drag.p95).toBeLessThanOrEqual(100);
  }
});
test("an embedded player shows host-supplied texts, document language and derived outline text", async ({
  page,
}) => {
  await page.goto("/content");
  await loadedGallery(page);
  const result = await page.evaluate(async () => {
    const host = document.createElement("div");
    host.style.cssText = "width:900px;height:600px;position:relative";
    document.body.append(host);
    const doc = structuredClone(window.demoDocument);
    doc.metadata.language = "en";
    const messages: Partial<PlayerMessages> = {
      lang: "en",
      outline: "Text view",
      reduceMotion: "Reduce motion",
      overview: "Overview",
      camera: "Camera",
      sceneView: "Scene view",
      panLeft: "Pan left",
      panRight: "Pan right",
      panUp: "Pan up",
      panDown: "Pan down",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      enableMedia: "Enable media",
      stage: "Spatial presentation",
      choices: "Path choices",
      mediaPlay: (label: string) => `Play ${label}`,
    };
    const player = window.createDemoPlayer({
      registry: window.contentRegistry,
      assets: {
        resolve: (id, signal) =>
          (
            window as unknown as {
              contentAPI: {
                createAssetResolver: typeof import("../../packages/player/src/index.js").createAssetResolver;
              };
            }
          ).contentAPI
            .createAssetResolver(doc.assets, window.contentBlobs)
            .resolve(id, signal),
      },
      messages,
    });
    await player.mount(host, doc);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const root = host.querySelector<HTMLElement>(".xc-player")!;
    const outline = root.querySelector(".xc-outline")!.textContent!;
    const out = {
      lang: root.lang,
      uiLang: root.querySelector<HTMLElement>(".xc-access")!.lang,
      controls: [
        ...root.querySelectorAll(".xc-access button, .xc-access summary"),
      ].map((b) => b.textContent),
      play: [...root.querySelectorAll('[data-block-type="video"] button')].map(
        (b) => b.textContent,
      ),
      outlineHasSource: /\*\*|<p>|<table|<svg|\\int/.test(outline),
      outlineHasText:
        outline.includes("Strong text") && outline.includes("Semantic HTML"),
    };
    player.destroy();
    host.remove();
    return out;
  });
  expect(result.lang).toBe("en");
  expect(result.uiLang).toBe("en");
  expect(result.controls).toEqual([
    "Text view",
    "Reduce motion",
    "Overview",
    "Camera",
    "Scene view",
    "Pan left",
    "Pan right",
    "Pan up",
    "Pan down",
    "Zoom in",
    "Zoom out",
    "Enable media",
  ]);
  expect(result.play[0]).toMatch(/^Play /);
  expect(result.outlineHasSource).toBe(false);
  expect(result.outlineHasText).toBe(true);
});
test("an unchanged playing video is not interrupted by updates to other blocks", async ({
  page,
}) => {
  await page.goto("/content");
  await loadedGallery(page);
  await page.evaluate(() =>
    window.demoPlayers[0]!.goTo({ nodeId: "video" }, { durationMs: 0 }),
  );
  const video = page.locator('#player-1 [data-block-type="video"] video');
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThan(0);
  await video.evaluate(async (v) => {
    const media = v as HTMLVideoElement;
    media.muted = true;
    media.loop = true;
    await media.play();
  });
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0);
  const before = await video.elementHandle();
  const result = await page.evaluate(async () => {
    const player = window.demoPlayers[0]!,
      doc = structuredClone(window.demoDocument);
    const markdown = doc.scenes.find((s) => s.id === "markdown")!.blocks[0]!;
    if (markdown.type === "markdown") markdown.data.source = "## Aggiornato";
    doc.scenes.find((s) => s.id === "text")!.title = "Updated title";
    const media = document.querySelector<HTMLVideoElement>(
      '#player-1 [data-block-type="video"] video',
    )!;
    const start = media.currentTime;
    for (let i = 0; i < 10; i++) await player.updateDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { paused: media.paused, advanced: media.currentTime > start };
  });
  expect(result).toEqual({ paused: false, advanced: true });
  expect(
    await page.evaluate(
      (v) =>
        v ===
        document.querySelector('#player-1 [data-block-type="video"] video'),
      before,
    ),
  ).toBe(true);
});
test("production Studio has no ws: in its CSP and no window.studio unless explicitly enabled", async ({
  page,
}) => {
  const html = await readFile("apps/studio/dist/index.html", "utf8");
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
    html,
  )?.[1];
  expect(csp).toBeTruthy();
  expect(csp).not.toMatch(/\bws:/);
  expect(csp).toMatch(/connect-src 'self'/);
  await page.goto("http://127.0.0.1:4174/");
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  expect(await page.evaluate(() => typeof window.studio)).toBe("undefined");
  expect(
    await page.evaluate(() =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')!
        .getAttribute("content"),
    ),
  ).not.toMatch(/\bws:/);
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  expect(await page.evaluate(() => typeof window.studio?.store)).toBe("object");
});
async function openStudio(page: Page, document: unknown = fixture) {
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  await page.getByLabel("JSON project file").setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
}
async function autosaved(page: Page, note: string) {
  await page.getByLabel("Speaker notes").fill(note);
  await page.getByLabel("Speaker notes").press("Tab");
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.studio!.repository.heads())
          .map((h) => h.document.scenes[0]?.notes)
          .join(),
      ),
    )
    .toContain(note);
}
test("a newer IndexedDB version from a second tab produces a persistent warning without losing work", async ({
  page,
  context,
}) => {
  await openStudio(page);
  await autosaved(page, "kept in memory");
  const other = await context.newPage();
  await other.route("http://127.0.0.1:4174/blank.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>blank</title>",
    }),
  );
  await other.goto("http://127.0.0.1:4174/blank.html");
  await other.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("spatialdeck-studio", 40);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  await expect(page.locator(".warning")).toContainText("newer version");
  await page.getByLabel("Speaker notes").fill("still editable");
  await page.getByLabel("Speaker notes").press("Tab");
  await expect(page.locator(".warning")).toContainText("newer version");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save JSON", exact: true }).click();
  const saved = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  ) as ProjectDocument;
  expect(saved.scenes[0]!.notes).toBe("still editable");
  expect(
    await page.evaluate(
      () => window.studio!.store.getSnapshot().document.scenes[0]!.notes,
    ),
  ).toBe("still editable");
});
test("an upgrade blocked by an old tab waits with a warning and resumes autosave when it closes", async ({
  page,
  context,
}) => {
  const old = await context.newPage();
  await old.route("http://127.0.0.1:4174/blank.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>old</title>",
    }),
  );
  await old.goto("http://127.0.0.1:4174/blank.html");
  await old.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        // A 0.4 tab: schema v2 and no versionchange handler.
        const request = indexedDB.open("spatialdeck-studio", 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("documents", { keyPath: "projectId" });
          db.createObjectStore("recovery", {
            keyPath: ["projectId", "revision"],
          });
          db.createObjectStore("assets", { keyPath: "key" });
        };
        request.onsuccess = () => {
          window.heldDatabase = request.result;
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  await openStudio(page);
  await page.getByLabel("Speaker notes").fill("waiting");
  await page.getByLabel("Speaker notes").press("Tab");
  await expect(page.locator(".warning")).toContainText(
    "another XCursus Studio tab",
  );
  await old.evaluate(() => window.heldDatabase!.close());
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.studio!.repository.heads()).map(
          (h) => h.document.scenes[0]?.notes,
        ),
      ),
    )
    .toEqual(["waiting"]);
  await expect(page.locator(".warning")).toHaveCount(0);
});
test("local projects and revisions can be deleted only after confirmation", async ({
  page,
}) => {
  await openStudio(page);
  await autosaved(page, "first");
  await autosaved(page, "second");
  await page.getByRole("button", { name: "Recovery", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Local recovery available",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete revision" }).click();
  const confirm = page.getByRole("dialog", {
    name: "Delete the local revision?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(
    await page.evaluate(async () => {
      const head = (await window.studio!.repository.heads())[0]!;
      return (await window.studio!.repository.revisions(head.projectId)).length;
    }),
  ).toBe(2);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete revision" }).click();
  await confirm.getByRole("button", { name: "Delete revision" }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const head = (await window.studio!.repository.heads())[0]!;
        return (await window.studio!.repository.revisions(head.projectId)).map(
          (r) => r.revision,
        );
      }),
    )
    .toEqual([1]);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete local project" }).click();
  const project = page.getByRole("dialog", {
    name: "Delete the local project?",
  });
  await project.getByRole("button", { name: "Delete project" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.studio!.repository.heads()).length,
      ),
    )
    .toBe(0);
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.studio!.store.getSnapshot().document.scenes[0]!.notes,
    ),
  ).toBe("second");
  await autosaved(page, "third");
  expect(
    await page.evaluate(
      async () => (await window.studio!.repository.heads())[0]!.revision,
    ),
  ).toBe(1);
});
test("recovery is proposed after unsaved edits but not after a clean save", async ({
  page,
}) => {
  await openStudio(page);
  await autosaved(page, "unsaved");
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "Local recovery available" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Recover revision" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save JSON", exact: true }).click();
  await download;
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.studio!.repository.heads())[0]!.saved,
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("open limits name the right file kind", async ({ page }) => {
  await page.goto(studioURL);
  await page.getByLabel("JSON project file").setInputFiles({
    name: "big.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 32),
  });
  await expect(page.getByRole("alert")).toContainText(
    "The JSON file exceeds 10 MiB",
  );
});
