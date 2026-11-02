import { readFile } from "node:fs/promises";
import { expect, test } from "./runner.js";
import { studioURL, writeEvidence } from "./evidence.js";
import { importImpress } from "../../packages/impress-compat/src/index.js";
import {
  cameraPose,
  projectScenePoint,
  resolveSceneCamera,
} from "../../packages/core/src/index.js";
import type { ProjectDocument } from "../../packages/core/src/index.js";
import type { Page } from "@playwright/test";

// impress.js import (1.0). The oracle is the upstream engine itself: the
// unmodified impress.js 2.0.0 bundle runs on the fixture in this browser, and
// the corners of every step on screen, with the camera at every step, are
// compared with the same corners of the imported document drawn by the
// XCursus player. Both run in a window of the configured size (scale 1).
const upstream = "packages/impress-compat/test/fixtures/upstream";
const decks: Array<{ name: string; file: string }> = [
  { name: "demo", file: `${upstream}/demo.html` },
  { name: "cube", file: `${upstream}/cube.html` },
  { name: "3D-rotations", file: `${upstream}/3D-rotations.html` },
  { name: "example", file: "examples/impress-import/deck.html" },
];
const ORIGIN = "http://impress.test";
type Point = [number, number];

/** Screen corners of every step, with impress.js at each step in turn. */
async function upstreamCorners(
  page: Page,
  html: string,
  size: [number, number],
): Promise<Point[][][]> {
  const engine = await readFile(`${upstream}/impress-2.0.0.js`, "utf8");
  // Every request stays inside the page: the deck, the engine, nothing else.
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/deck.html")
      return route.fulfill({ contentType: "text/html", body: html });
    if (path.endsWith("/impress.js"))
      return route.fulfill({
        contentType: "text/javascript",
        body: engine,
      });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/deck.html`);
  return page.evaluate(([width, height]) => {
    // The same box for every step as the imported scenes, so only the transforms differ.
    const style = document.createElement("style");
    style.textContent = `.step{width:${width}px!important;height:${height}px!important;padding:0!important;border:0!important;margin:0!important;box-sizing:border-box!important;overflow:hidden}`;
    document.head.append(style);
    const api = (
      window as unknown as {
        impress: () => { goto: (i: number, d: number) => unknown };
      }
    ).impress();
    const steps = [...document.querySelectorAll<HTMLElement>("#impress .step")];
    const markers = steps.map((step) =>
      [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
        [width / 2, height / 2],
      ].map(([x, y]) => {
        const m = document.createElement("span");
        m.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
        step.append(m);
        return m;
      }),
    );
    return steps.map((_, active) => {
      api.goto(active, 0);
      return markers.map((points) =>
        points.map((m) => {
          const r = m.getBoundingClientRect();
          return [r.x, r.y] as [number, number];
        }),
      );
    });
  }, size);
}

/** The same corners drawn by the XCursus player, at each node of the imported path. */
async function playerCorners(
  page: Page,
  document: ProjectDocument,
): Promise<Point[][][]> {
  await page.goto("/core");
  await expect(page.locator(".xc-player")).toHaveCount(2);
  return page.evaluate(async (json) => {
    const doc = JSON.parse(json) as {
      settings: { viewport: { width: number; height: number } };
      scenes: Array<{ id: string; size: [number, number] }>;
      paths: Array<{ nodes: Array<{ id: string }> }>;
    };
    const host = window.document.createElement("div");
    host.style.cssText = `position:fixed;left:0;top:0;width:${doc.settings.viewport.width}px;height:${doc.settings.viewport.height}px;z-index:10`;
    window.document.body.append(host);
    const player = window.createDemoPlayer({ controls: false });
    const mounted = await player.mount(host, JSON.parse(json));
    if (!mounted.ok) throw new Error(JSON.stringify(mounted.diagnostics));
    const markers = doc.scenes.map((scene) => {
      const wrapper = host.querySelector(`[data-scene-id="${scene.id}"]`)!;
      const [w, h] = scene.size;
      return [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
        [w / 2, h / 2],
      ].map(([x, y]) => {
        const m = window.document.createElement("span");
        m.style.cssText = `position:absolute;left:${x! - w / 2}px;top:${y! - h / 2}px;width:0;height:0`;
        wrapper.append(m);
        return m;
      });
    });
    // Player pixels to viewport units: the stage letterboxes the viewport.
    const stage = host.querySelector(".xc-stage")!.getBoundingClientRect();
    const { width, height } = doc.settings.viewport;
    const fit = Math.min(stage.width / width, stage.height / height);
    const toViewport = (box: DOMRect): [number, number] => [
      (box.x - (stage.x + stage.width / 2)) / fit + width / 2,
      (box.y - (stage.y + stage.height / 2)) / fit + height / 2,
    ];
    const result: Array<Array<Array<[number, number]>>> = [];
    for (const node of doc.paths[0]!.nodes) {
      const r = await player.goTo({ nodeId: node.id }, { durationMs: 0 });
      if (r.status !== "completed" && r.status !== "noop")
        throw new Error(JSON.stringify(r));
      result.push(
        markers.map((points) =>
          points.map((m) => toViewport(m.getBoundingClientRect())),
        ),
      );
    }
    player.destroy();
    host.remove();
    return result;
  }, JSON.stringify(document));
}

for (const deck of decks)
  test(`impress.js import: ${deck.name} matches the upstream engine on screen`, async ({
    page,
  }, info) => {
    const html = await readFile(deck.file, "utf8");
    const imported = importImpress(html, { profile: "bundle" });
    if (!imported.ok) throw new Error(JSON.stringify(imported.diagnostics));
    const doc = imported.value.document;
    const { width, height } = doc.settings.viewport;
    await page.setViewportSize({ width, height });
    const size = doc.scenes[0]!.size;
    expect(doc.scenes.every((s) => s.size.join() === size.join())).toBe(true);
    const reference = await upstreamCorners(page, html, size);
    await page.unrouteAll();
    const drawn = await playerCorners(page, doc);
    // Every step of these decks is on the path, in the same order.
    expect(drawn).toHaveLength(reference.length);
    // The exact projection of the core, which the unit tests prove equal to
    // the independent CSS oracle within 1e-6.
    const exact = doc.paths[0]!.nodes.map((node) => {
      const fit = resolveSceneCamera(doc, node.sceneId);
      if (!node.camera && !fit.ok) throw new Error(node.sceneId);
      const camera = node.camera
        ? cameraPose(node.camera)
        : (fit as Extract<typeof fit, { ok: true }>).value;
      return doc.scenes.map((scene) => {
        const [w, h] = scene.size;
        return (
          [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
            [w / 2, h / 2],
          ] as Point[]
        ).map((p) => {
          const r = projectScenePoint(doc, scene.id, camera, p);
          return r.ok ? r.value : null;
        });
      });
    });
    let compared = 0;
    const worst = { player: 0, upstream: 0 };
    const window = Math.max(width, height);
    exact.forEach((cameras, a) =>
      cameras.forEach((points, s) =>
        points.forEach((want, k) => {
          // Behind the eye, or far outside the window near the eye plane: not compared.
          if (!want || want.some((v) => Math.abs(v) > 4 * window)) return;
          const where = `${deck.name}: camera ${a}, scene ${s}, corner ${k}`;
          const distance = Math.hypot(
            want[0] - width / 2,
            want[1] - height / 2,
          );
          const off = (p: Point) => Math.hypot(p[0] - want[0], p[1] - want[1]);
          const player = off(drawn[a]![s]![k]!),
            engine = off(reference[a]![s]![k]!);
          worst.player = Math.max(worst.player, player);
          worst.upstream = Math.max(worst.upstream, engine);
          compared++;
          // The player draws one matrix per scene: layout rounding only.
          expect(player, `XCursus ${where}`).toBeLessThanOrEqual(
            Math.max(0.5, 2e-4 * distance),
          );
          // impress.js chains root scale, perspective, canvas and step
          // transforms; WebKit rounds that chain to about a pixel.
          expect(engine, `impress.js ${where}`).toBeLessThanOrEqual(
            Math.max(1.5, 5e-4 * distance),
          );
        }),
      ),
    );
    expect(compared).toBeGreaterThan(doc.scenes.length * 5);
    await writeEvidence(`impress-${deck.name}-${info.project.name}.json`, {
      deck: deck.file,
      viewport: [width, height],
      scenes: doc.scenes.length,
      compared,
      worstErrorPx: worst,
      engine: info.project.name,
    });
  });

test("impress.js import in Studio: review, then open without losing the open work", async ({
  page,
}) => {
  await page.goto(studioURL);
  // Unsaved work in the open document.
  await page.getByRole("button", { name: "Create the first scene" }).click();
  await page.getByLabel("Project title").fill("Work in progress");
  const before = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  await expect
    .poll(() => page.evaluate(() => window.studio!.store.getSnapshot().dirty))
    .toBe(true);

  await page.getByRole("button", { name: "Import impress.js" }).click();
  const panel = page.getByRole("dialog", { name: "Import impress.js" });
  await expect(panel).toBeVisible();
  await panel
    .getByLabel("impress.js HTML file")
    .setInputFiles("examples/impress-import/deck.html");
  await panel
    .getByLabel("Images and media of the presentation")
    .setInputFiles([
      "examples/impress-import/images/ring.png",
      "examples/impress-import/images/axes.svg",
    ]);
  await panel.getByRole("combobox").selectOption("bundle");
  await panel.getByRole("button", { name: "Convert" }).click();
  await expect(panel).toContainText("6 scenes, 6 on the path, 2 assets");
  await expect(panel).toContainText("RESOURCE_REMOTE");
  await expect(panel).toContainText("CSS_NOT_CONVERTED");
  await expect(panel).toContainText("https://example.org/remote.png (remote)");
  // Reviewing changes nothing.
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);
  // Cancel keeps the open work.
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toBeHidden();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);

  // Again, then open: unsaved changes ask for confirmation first.
  await page.getByRole("button", { name: "Import impress.js" }).click();
  await panel
    .getByLabel("impress.js HTML file")
    .setInputFiles("examples/impress-import/deck.html");
  await panel
    .getByLabel("Images and media of the presentation")
    .setInputFiles([
      "examples/impress-import/images/ring.png",
      "examples/impress-import/images/axes.svg",
    ]);
  await panel.getByRole("button", { name: "Convert" }).click();
  await expect(panel).toContainText("6 scenes");
  await panel.getByRole("button", { name: "Open candidate" }).click();
  const confirm = page.getByRole("dialog", { name: "Discard changes?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);

  await page.getByRole("button", { name: "Import impress.js" }).click();
  await panel
    .getByLabel("impress.js HTML file")
    .setInputFiles("examples/impress-import/deck.html");
  await panel
    .getByLabel("Images and media of the presentation")
    .setInputFiles([
      "examples/impress-import/images/ring.png",
      "examples/impress-import/images/axes.svg",
    ]);
  await panel.getByRole("button", { name: "Convert" }).click();
  await expect(panel).toContainText("6 scenes");
  await panel.getByRole("button", { name: "Open candidate" }).click();
  await page
    .getByRole("dialog", { name: "Discard changes?" })
    .getByRole("button", { name: "Continue" })
    .click();
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(6);
  await expect(page.locator(".warning")).toContainText(
    "Opened an impress.js import candidate",
  );
  await expect(page.locator(".warning")).toContainText(
    "The previous unsaved changes are in Recovery",
  );
  const opened = await page.evaluate(() => {
    const doc = window.studio!.store.getSnapshot().document;
    return {
      title: doc.metadata.title,
      scenes: doc.scenes.map((s) => s.id),
      assets: doc.assets.map((a) => a.path),
    };
  });
  expect(opened).toEqual({
    title: "Spaces between ideas",
    scenes: ["welcome", "beside", "below", "depth", "sources", "overview"],
    assets: ["images/ring.png", "images/axes.svg"],
  });
  // The images render in the preview (assets resolved from the chosen files).
  await expect(
    page.locator('.preview-player [data-scene-id="beside"] img'),
  ).toHaveCount(1);
  // The previous work is in local recovery.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.studio!.repository.heads()).map(
          (h) => h.document.metadata.title,
        ),
      ),
    )
    .toContain("Work in progress");
});

test("hostile impress.js HTML imported in Studio runs nothing and loads nothing", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4174")) requests.push(r.url());
  });
  await page.goto(studioURL);
  await page.getByRole("button", { name: "Import impress.js" }).click();
  const panel = page.getByRole("dialog", { name: "Import impress.js" });
  // Oversized input is refused before it is read.
  await panel.getByLabel("impress.js HTML file").setInputFiles({
    name: "large.html",
    mimeType: "text/html",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 32),
  });
  await panel.getByRole("button", { name: "Convert" }).click();
  await expect(panel).toContainText("The HTML file exceeds 10 MiB.");
  await expect(
    panel.getByRole("button", { name: "Open candidate" }),
  ).toBeDisabled();
  await panel.getByLabel("impress.js HTML file").setInputFiles({
    name: "hostile.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      `<!doctype html><html><head><script>window.pwned=1</script><link rel="stylesheet" href="https://evil.example/x.css"></head>
      <body onload="window.pwned=2"><div id="impress"><div class="step" onclick="window.pwned=3">
      <img src="https://evil.example/a.png" onerror="window.pwned=4" alt="x">
      <svg onload="window.pwned=5"><script>window.pwned=6</script><rect width="5" height="5"/></svg>
      <iframe src="https://evil.example/"></iframe><a href="javascript:window.pwned=7">x</a>
      <p>Visible text</p></div></div></body></html>`,
    ),
  });
  await panel.getByRole("button", { name: "Convert" }).click();
  await expect(panel).toContainText("1 scene,");
  await panel.getByRole("button", { name: "Open candidate" }).click();
  await expect(page.locator(".preview-player")).toContainText("Visible text");
  expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBe(
    undefined,
  );
  expect(requests).toEqual([]);
  expect(
    await page
      .locator(".preview-player iframe, .preview-player script")
      .count(),
  ).toBe(0);
});
