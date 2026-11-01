import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import {
  cameraPose,
  frameBounds,
  frameMatrix,
  frameToScene,
  projectScenePoint,
  resolveSceneCamera,
  updateCapabilities,
  validateDocument,
} from "../../packages/core/src/index.js";
import type {
  CameraPose,
  Frame,
  Point,
  ProjectDocument,
} from "../../packages/core/src/index.js";
import project from "../../examples/layout-canvas/project.json" with { type: "json" };
import { test, expect } from "./runner.js";
import { evidencePath, studioURL, writeEvidence } from "./evidence.js";
declare global {
  interface Window {
    layoutBlobs: Map<string, Blob>;
    cspViolations: string[];
  }
}
const archive = "examples/layout-canvas/layout-canvas.xcursus";
const doc = (input: unknown = project): ProjectDocument => {
  const r = validateDocument(input);
  if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
  return r.value;
};
const scene = (d: ProjectDocument, id: string) =>
  d.scenes.find((s) => s.id === id)!;
const frame = (d: ProjectDocument, sceneId: string, blockId: string) =>
  scene(d, sceneId).blocks.find((b) => b.id === blockId)!.frame!;
const locals = (f: Frame): Point[] => [
  [0, 0],
  [f.width, 0],
  [f.width, f.height],
  [0, f.height],
  [f.width / 2, f.height / 2],
];
/** Core expectation in viewport pixels relative to the viewport centre. */
function expected(
  d: ProjectDocument,
  sceneId: string,
  camera: CameraPose,
  f: Frame,
): Point[] {
  return locals(f).map((p) => {
    const r = projectScenePoint(d, sceneId, camera, frameToScene(f, p));
    if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
    return [
      r.value[0] - d.settings.viewport.width / 2,
      r.value[1] - d.settings.viewport.height / 2,
    ];
  });
}
/** Rendered frame landmarks: zero-size markers inside each block host. */
async function rendered(
  page: Page,
  host: string,
  sceneId: string,
  blocks: Array<{ id: string; points: Point[] }>,
) {
  return page.evaluate(
    ({ host, sceneId, blocks }) => {
      const root = document.querySelector(host)!;
      const viewport = root.querySelector<HTMLElement>(".xc-viewport")!,
        rect = viewport.getBoundingClientRect(),
        fit = rect.width / parseFloat(viewport.style.width);
      return blocks.map(({ id, points }) => {
        const element = root.querySelector<HTMLElement>(
          `.xc-scene[data-scene-id="${sceneId}"] [data-block-id="${id}"]`,
        )!;
        return points.map(([x, y]) => {
          const marker = document.createElement("i");
          marker.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
          element.append(marker);
          const b = marker.getBoundingClientRect();
          marker.remove();
          return [
            (b.x - rect.x - rect.width / 2) / fit,
            (b.y - rect.y - rect.height / 2) / fit,
          ];
        });
      });
    },
    { host, sceneId, blocks },
  );
}
const close = (a: number[][], b: number[][], tolerance = 1) =>
  a.forEach((point, i) =>
    point.forEach((n, j) =>
      expect(Math.abs(n - b[i]![j]!)).toBeLessThanOrEqual(tolerance),
    ),
  );
async function vanilla(page: Page) {
  await page.goto("/layout");
  await expect(page.locator(".xc-player")).toHaveCount(2);
  await expect(
    page.locator('#player-1 [data-block-id="picture"] img'),
  ).toHaveCount(1);
}
/** Content point of a scene -> client pixel, through the core projection. */
async function clientPoint(
  page: Page,
  host: string,
  d: ProjectDocument,
  sceneId: string,
  camera: CameraPose,
  point: Point,
) {
  const r = projectScenePoint(d, sceneId, camera, point);
  if (!r.ok) throw Error();
  return page.evaluate(
    ({ host, x, y, width }) => {
      const viewport = document
        .querySelector(host)!
        .querySelector<HTMLElement>(".xc-viewport")!;
      const rect = viewport.getBoundingClientRect(),
        fit = rect.width / width;
      return [rect.x + x * fit, rect.y + y * fit] as const;
    },
    {
      host,
      x: r.value[0],
      y: r.value[1],
      width: d.settings.viewport.width,
    },
  );
}
/** Documents cross into the page as JSON text: Playwright's argument types are too deep for them. */
const update = (page: Page, next: ProjectDocument, nodeId?: string) =>
  page.evaluate(
    async ({ json, nodeId }) => {
      const r = await window.demoPlayers[0]!.updateDocument(JSON.parse(json));
      if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
      if (nodeId)
        await window.demoPlayers[0]!.goTo({ nodeId }, { durationMs: 0 });
    },
    { json: JSON.stringify(next), nodeId },
  );
const blockAt = (page: Page, point: readonly [number, number]) =>
  page.evaluate(
    ([x, y]) =>
      document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-block-id]")
        ?.dataset.blockId ?? null,
    point,
  );
test.describe("player", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });
  test("canvas frame corners and centres land within 1 px of the core projection on rotated and nested scenes", async ({
    page,
  }, info) => {
    await vanilla(page);
    const d = doc();
    const evidence: Record<string, unknown> = {};
    for (const [nodeId, sceneId, rotation] of [
      ["n1", "cover", [8, 14, -6]],
      ["n3", "details", [0, 0, 0]],
    ] as const) {
      const fit = resolveSceneCamera(d, sceneId);
      if (!fit.ok) throw Error();
      const oblique: CameraPose = {
        ...cameraPose({
          position: fit.value.position,
          rotation: [...rotation],
          zoom: fit.value.zoom * 0.85,
        }),
      };
      for (const camera of [fit.value, oblique]) {
        await page.evaluate(
          async ({ nodeId, camera }) => {
            await window.demoPlayers[0]!.goTo({ nodeId }, { durationMs: 0 });
            window.demoPlayers[0]!.setCamera(camera);
          },
          { nodeId, camera },
        );
        const blocks = scene(d, sceneId).blocks.map((b) => ({
          id: b.id,
          points: locals(b.frame!),
        }));
        const measured = await rendered(page, "#player-1", sceneId, blocks);
        const wanted = scene(d, sceneId).blocks.map((b) =>
          expected(d, sceneId, camera, b.frame!),
        );
        measured.forEach((points, i) => close(points, wanted[i]!));
        evidence[`${sceneId}-${camera === fit.value ? "fit" : "oblique"}`] = {
          measured,
          expected: wanted,
        };
      }
    }
    await writeEvidence(`layout/landmarks-${info.project.name}.json`, evidence);
    if (info.project.name === "chromium")
      await page
        .locator("#player-1")
        .screenshot({ path: evidencePath("layout/player-oblique.png") });
  });
  test("clipping, z overlap, DOM and Tab order follow the model, and a hidden title stays the scene name", async ({
    page,
  }, info) => {
    await vanilla(page);
    const d = doc();
    const camera = resolveSceneCamera(d, "cover");
    if (!camera.ok) throw Error();
    const cover = page.locator(
      '#player-1 .xc-scene[data-scene-id="cover"] .xc-content',
    );
    await expect(cover).toHaveClass(/xc-layout-canvas/);
    expect(
      await cover
        .locator("[data-block-id]")
        .evaluateAll((els) =>
          els.map((e) => (e as HTMLElement).dataset.blockId),
        ),
    ).toEqual(scene(d, "cover").blocks.map((b) => b.id));
    // Clipping sits on the content wrapper; the spatial wrapper keeps preserve-3d.
    expect(
      await cover.evaluate((el) => [
        getComputedStyle(el).overflow,
        getComputedStyle(el.parentElement!).transformStyle,
        getComputedStyle(el.parentElement!).overflow,
      ]),
    ).toEqual(["hidden", "preserve-3d", "visible"]);
    // The stamp (z 4) covers the picture (z 0) where they overlap.
    const overlap = await clientPoint(
      page,
      "#player-1",
      d,
      "cover",
      camera.value,
      [530, 120],
    );
    expect(await blockAt(page, overlap)).toBe("stamp");
    const lowered = structuredClone(d);
    frame(lowered, "cover", "stamp").z = -1;
    await update(page, lowered);
    expect(await blockAt(page, overlap)).toBe("picture");
    // A rotated corner beyond the scene rectangle is clipped, the inside is not.
    await page
      .locator("#player-1")
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    const clipped = structuredClone(lowered);
    frame(clipped, "cover", "note").x = 1000;
    frame(clipped, "cover", "note").y = 575;
    frame(clipped, "cover", "note").width = 200;
    frame(clipped, "cover", "note").rotation = 45;
    await update(page, clipped);
    const note = frame(clipped, "cover", "note");
    const inside = frameToScene(note, [160, 50]),
      outside = frameToScene(note, [195, 50]);
    expect(inside[1]).toBeLessThan(675);
    expect(outside[1]).toBeGreaterThan(675);
    expect(
      await blockAt(
        page,
        await clientPoint(page, "#player-1", d, "cover", camera.value, inside),
      ),
    ).toBe("note");
    expect(
      await blockAt(
        page,
        await clientPoint(page, "#player-1", d, "cover", camera.value, outside),
      ),
    ).toBeNull();
    // Tab follows the array, not the position or z.
    const links = structuredClone(d);
    scene(links, "cover").blocks = ["first", "second", "third"].map(
      (id, i) => ({
        id,
        type: "link",
        data: { label: `Link ${id}`, target: { pathId: "main", nodeId: "n2" } },
        frame: {
          x: 800 - i * 350,
          y: 300,
          width: 300,
          height: 80,
          rotation: 0,
          z: 10 - i,
        },
      }),
    );
    await update(page, links, "n1");
    await page.locator("#player-1 .xc-player button").first().focus();
    const order: string[] = [];
    // WebKit, like Safari by default, reaches buttons and links with Option+Tab.
    const tab = info.project.name === "webkit" ? "Alt+Tab" : "Tab";
    for (let i = 0; i < 14 && order.length < 3; i++) {
      await page.keyboard.press(tab);
      const id = await page.evaluate(
        () =>
          document.activeElement?.closest<HTMLElement>("[data-block-id]")
            ?.dataset.blockId ?? null,
      );
      if (id && !order.includes(id)) order.push(id);
    }
    expect(order).toEqual(["first", "second", "third"]);
    // Hidden title: not visible, still the accessible name and in the outline.
    await update(page, d);
    const article = page
      .locator("#player-1")
      .getByRole("article", { name: "Spaces that read" });
    await expect(article).toHaveCount(1);
    const box = await cover.locator("h2").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(1.01);
    expect(box!.height).toBeLessThanOrEqual(1.01);
    await page
      .locator("#player-1")
      .getByRole("button", { name: "Text view" })
      .click();
    await expect(page.locator("#player-1 .xc-outline")).toContainText(
      "Spaces that read",
    );
    const outline = await page
      .locator("#player-1 .xc-outline li")
      .first()
      .locator("p")
      .allTextContents();
    expect(outline[0]).toBe("Spaces that read");
    expect(outline[2]).toContain("Illustration");
  });
  test("theme and block tokens apply under a CSP without unsafe-inline, and theme fonts load only when used", async ({
    page,
  }, info) => {
    await page.addInitScript(() => {
      window.cspViolations = [];
      // The target element and sample name the source of an inline violation.
      document.addEventListener("securitypolicyviolation", (e) => {
        const target = e.target as Element | null;
        window.cspViolations.push(
          `${e.violatedDirective} ${e.blockedURI} ${target?.nodeName ?? ""}.${
            target?.getAttribute?.("class") ?? ""
          } ${target?.closest?.(".xc-player") ? "player" : "page"} ${
            e.sample
          } ${target?.outerHTML?.slice(0, 160) ?? ""}`,
        );
      });
    });
    await page.route(/127\.0\.0\.1:4173\/(?:core|layout)$/, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'",
        },
      });
    });
    await page.goto("/core");
    await expect(page.locator(".xc-player")).toHaveCount(2);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () =>
          performance
            .getEntriesByType("resource")
            .filter((e) => e.name.includes("atkinson")).length,
      ),
    ).toBe(0);
    await vanilla(page);
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => ({
      files: performance
        .getEntriesByType("resource")
        .map((e) => e.name.split("/").pop()!)
        .filter((n) => n.includes("atkinson")),
      loaded: document.fonts.check('26px "XCursus Atkinson Hyperlegible"'),
    }));
    expect(fonts.loaded).toBe(true);
    expect(fonts.files.some((n) => n.includes("latin-400-normal"))).toBe(true);
    const content = page.locator(
      '#player-1 .xc-scene[data-scene-id="cover"] .xc-content',
    );
    const styles = await content.evaluate((el) => {
      const c = getComputedStyle(el),
        stage = getComputedStyle(el.closest(".xc-stage")!),
        headline = getComputedStyle(
          el.querySelector('[data-block-id="headline"]')!,
        );
      return {
        background: c.backgroundColor,
        color: c.color,
        font: c.fontFamily,
        size: c.fontSize,
        shadow: c.boxShadow,
        backdrop: stage.backgroundColor,
        headlineColor: headline.color,
        headlineSize: headline.fontSize,
      };
    });
    expect(styles).toMatchObject({
      background: "rgb(255, 250, 240)",
      color: "rgb(27, 31, 59)",
      size: "26px",
      backdrop: "rgb(30, 41, 59)",
      headlineColor: "rgb(154, 52, 18)",
    });
    expect(styles.font).toContain("XCursus Atkinson Hyperlegible");
    expect(styles.shadow).toContain("rgb(249, 115, 22)");
    expect(parseFloat(styles.headlineSize)).toBeCloseTo(26 * 2.2, 1);
    // Motivated exception: Playwright's Linux WebKit (CI) reports
    // style-src-attr for the native <select> controls of the playground page
    // itself, outside the player: engine-internal styling of the control, no
    // style attribute is written by the page or the player. Anything else,
    // and every violation inside the player, still fails.
    const violations = (await page.evaluate(() => window.cspViolations)).filter(
      (v) =>
        !(
          info.project.name === "webkit" &&
          /^style-src-attr inline SELECT\. page /.test(v)
        ),
    );
    expect(violations).toEqual([]);
    await writeEvidence(`layout/csp-fonts-${info.project.name}.json`, {
      fonts,
      styles,
      violations: [],
    });
  });
  test("images and video fill their frames with the effective fit", async ({
    page,
  }) => {
    await page.goto("/content");
    await expect(page.locator(".xc-player")).toHaveCount(2);
    await page.evaluate(async () => {
      const d = structuredClone(window.demoDocument);
      for (const id of ["image", "video"]) {
        const s = d.scenes.find((x) => x.id === id)!;
        s.layout = "canvas";
        s.blocks.forEach((b, i) => {
          b.frame = {
            x: 40 + i * 10,
            y: 30,
            width: 420,
            height: 260,
            rotation: 0,
            z: 0,
          };
        });
      }
      d.requiredCapabilities = [...d.requiredCapabilities, "layout"];
      const r = await window.demoPlayers[0]!.updateDocument(d);
      if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
      await window.demoPlayers[0]!.goTo({ nodeId: "image" }, { durationMs: 0 });
    });
    const image = page.locator("#player-1 [data-block-id] img").first();
    await expect
      .poll(() => image.evaluate((i) => (i as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    const [imgBox, imgHost] = await image.evaluate((i) => [
      i.getBoundingClientRect().toJSON(),
      i.closest("[data-block-id]")!.getBoundingClientRect().toJSON(),
    ]);
    for (const key of ["x", "y", "width", "height"] as const)
      expect(Math.abs(imgBox[key] - imgHost[key])).toBeLessThanOrEqual(1);
    expect(await image.evaluate((i) => getComputedStyle(i).objectFit)).toBe(
      (
        doc(await page.evaluate(() => window.demoDocument)).scenes.find(
          (s) => s.id === "image",
        )!.blocks[0]!.data as { fit: string }
      ).fit,
    );
    await page.evaluate(() =>
      window.demoPlayers[0]!.goTo({ nodeId: "video" }, { durationMs: 0 }),
    );
    const video = page.locator('#player-1 [data-block-type="video"] video');
    await expect(video).toHaveCount(1);
    const [videoBox, videoHost] = await video.evaluate((v) => [
      v.getBoundingClientRect().toJSON(),
      v.closest("[data-block-id]")!.getBoundingClientRect().toJSON(),
    ]);
    expect(Math.abs(videoBox.width - videoHost.width)).toBeLessThanOrEqual(1);
    expect(videoBox.height).toBeGreaterThan(videoHost.height * 0.5);
    expect(videoBox.y + videoBox.height).toBeLessThanOrEqual(
      videoHost.y + videoHost.height + 0.5,
    );
  });
  test("migrated historical documents keep the 1.2.0 flow rendering tokens and markup", async ({
    page,
  }) => {
    for (const route of ["/core", "/structure", "/content"]) {
      await page.goto(route);
      await expect(page.locator(".xc-player")).toHaveCount(2);
      const result = await page.evaluate(() => {
        const player = document.querySelector("#player-1")!;
        const contents = [
          ...player.querySelectorAll<HTMLElement>(".xc-content"),
        ];
        const style = (el: Element) => {
          const c = getComputedStyle(el);
          return [
            c.paddingTop,
            c.borderTopWidth,
            c.borderTopStyle,
            c.borderTopColor,
            c.backgroundColor,
            c.color,
            c.fontFamily,
            c.fontSize,
            c.borderTopLeftRadius,
            c.boxShadow,
            c.overflow,
          ].join("|");
        };
        return {
          contents: [...new Set(contents.map(style))],
          classes: [...new Set(contents.map((c) => c.className))],
          titles: [
            ...new Set(
              contents.map((c) => {
                const h = getComputedStyle(c.querySelector("h2")!);
                return `${h.fontSize}|${h.marginBottom}|${h.fontFamily}|${h.position}`;
              }),
            ),
          ],
          blocks: [
            ...new Set(
              [...player.querySelectorAll<HTMLElement>("[data-block-id]")].map(
                (b) =>
                  `${/xc-(?:framed|align|valign|size)/.test(b.className)}|${b.getAttribute("style") ?? ""}`,
              ),
            ),
          ],
          stage: getComputedStyle(player.querySelector(".xc-stage")!)
            .backgroundColor,
        };
      });
      expect(result.classes).toEqual(["xc-content"]);
      expect(result.contents).toHaveLength(1);
      const [
        padding,
        border,
        borderStyle,
        borderColor,
        background,
        color,
        font,
        size,
        radius,
        shadow,
        overflow,
      ] = result.contents[0]!.split("|");
      expect([
        padding,
        border,
        borderStyle,
        borderColor,
        background,
        color,
        size,
        radius,
        overflow,
      ]).toEqual([
        "48px",
        "3px",
        "solid",
        "rgb(33, 91, 175)",
        "rgb(255, 255, 255)",
        "rgb(23, 32, 53)",
        "28px",
        "8px",
        "auto",
      ]);
      expect(font).toMatch(/system-ui, sans-serif/);
      expect(shadow).toContain("0px 6px 24px");
      expect(result.titles).toHaveLength(1);
      expect(result.titles[0]).toMatch(
        /^46px\|32px\|system-ui, sans-serif\|static$/,
      );
      expect(result.blocks).toEqual(["false|"]);
      expect(result.stage).toBe("rgb(232, 237, 244)");
    }
  });
});
/* ------------------------------------------------------------------ Studio */
async function openStudio(
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer } = archive,
) {
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  await page.getByLabel("JSON project file").setInputFiles(file);
  await expect(page.getByLabel("Project title")).not.toHaveValue("Untitled");
}
async function openLayout(page: Page) {
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  const count = await page.evaluate(() => {
    const s = window.studio!.store.getSnapshot();
    return s.document.scenes.find((x) => x.id === s.selection)!.blocks.length;
  });
  await expect(page.locator("[data-layout-block]")).toHaveCount(count);
}
const studioDoc = (page: Page) =>
  page.evaluate(() => window.studio!.store.getSnapshot().document);
const history = (page: Page) =>
  page.evaluate(() => window.studio!.store.getSnapshot().historyLength);
const studioFrame = async (page: Page, sceneId: string, blockId: string) =>
  frame(await studioDoc(page), sceneId, blockId);
/** Overlay pixels per scene pixel, from the rendered overlay frame. */
async function scale(page: Page, blockId: string, f: Frame) {
  const box = await page
    .locator(`[data-layout-block="${blockId}"]`)
    .evaluate((el) => (el as HTMLElement).offsetWidth);
  return box / f.width;
}
const centre = async (page: Page, selector: string) => {
  const b = (await page.locator(selector).boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2] as const;
};
/** The preview host matches the stored frame through the core matrix. */
async function previewMatches(page: Page, sceneId: string, blockId: string) {
  const f = await studioFrame(page, sceneId, blockId);
  await expect
    .poll(() =>
      page
        .locator(
          `.preview-player .xc-scene[data-scene-id="${sceneId}"] [data-block-id="${blockId}"]`,
        )
        .evaluate((el) =>
          (el as HTMLElement).style.transform
            .replace(/^matrix\(|\)$/g, "")
            .split(",")
            .map(Number),
        )
        .then((values) =>
          // Engines serialize transform numbers with different precision.
          Math.max(...frameMatrix(f).map((n, i) => Math.abs(n - values[i]!))),
        ),
    )
    .toBeLessThanOrEqual(0.01);
}
/**
 * Entering the scene editor resizes the preview: the overlay is compared once
 * the player has refitted its viewport (one resize notification later). A
 * lasting offset still fails when the poll times out.
 */
async function overlayAligned(page: Page, sceneId: string) {
  const offsets = () =>
    page.evaluate((sceneId) => {
      return [
        ...document.querySelectorAll<HTMLElement>("[data-layout-block]"),
      ].map((f) => {
        const b = document.querySelector(
          `.preview-player .xc-scene[data-scene-id="${sceneId}"] [data-block-id="${f.dataset.layoutBlock}"]`,
        )!;
        const r1 = f.getBoundingClientRect(),
          r2 = b.getBoundingClientRect();
        return [
          r1.x - r2.x,
          r1.y - r2.y,
          r1.width - r2.width,
          r1.height - r2.height,
        ];
      });
    }, sceneId);
  expect((await offsets()).length).toBeGreaterThan(0);
  await expect
    .poll(async () => Math.max(...(await offsets()).flat().map(Math.abs)))
    .toBeLessThanOrEqual(1);
}
test.describe("Studio scene editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });
  test("drag, resize, rotate, arrows and numeric fields: one undo per gesture, Escape cancels", async ({
    page,
  }, info) => {
    await openStudio(page);
    await openLayout(page);
    await overlayAligned(page, "cover");
    const start = await studioFrame(page, "cover", "summary");
    const k = await scale(page, "summary", start);
    const before = await history(page);
    // Move: one command for the whole drag.
    let [x, y] = await centre(page, '[data-layout-block="summary"]');
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(x - i * 10, y - i * 8);
    await page.mouse.up();
    const moved = await studioFrame(page, "cover", "summary");
    expect(Math.abs(moved.x - (start.x - 60 / k))).toBeLessThanOrEqual(1);
    expect(Math.abs(moved.y - (start.y - 48 / k))).toBeLessThanOrEqual(1);
    expect(moved.width).toBe(start.width);
    expect(await history(page)).toBe(before + 1);
    await previewMatches(page, "cover", "summary");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await studioFrame(page, "cover", "summary")).toEqual(start);
    expect(await history(page)).toBe(before);
    // Escape during the drag restores the frame and records nothing.
    [x, y] = await centre(page, '[data-layout-block="summary"]');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 30);
    await page.mouse.move(x + 80, y + 50);
    expect((await studioFrame(page, "cover", "summary")).x).not.toBe(start.x);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await studioFrame(page, "cover", "summary")).toEqual(start);
    expect(await history(page)).toBe(before);
    expect(
      await page.evaluate(() => window.studio!.store.getSnapshot().dragging),
    ).toBe(false);
    // Resize from the south-west corner: the north-east corner stays.
    await page.locator('[data-layout-block="summary"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".layout-handle")).toHaveCount(9);
    [x, y] = await centre(page, '[data-handle="sw"]');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 20, y + 10);
    await page.mouse.move(x - 40, y + 20);
    await page.mouse.up();
    const resized = await studioFrame(page, "cover", "summary");
    expect(
      Math.abs(resized.width - (start.width + 40 / k)),
    ).toBeLessThanOrEqual(1.5);
    expect(
      Math.abs(resized.height - (start.height + 20 / k)),
    ).toBeLessThanOrEqual(1.5);
    expect([resized.x + resized.width, resized.y]).toEqual([
      start.x + start.width,
      start.y,
    ]);
    expect(await history(page)).toBe(before + 1);
    // Rotate a quarter turn with Shift snapping to 15°.
    const [cx, cy] = await centre(page, '[data-layout-block="summary"]');
    [x, y] = await centre(page, '[data-handle="rotate"]');
    const r = Math.hypot(x - cx, y - cy);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.keyboard.down("Shift");
    for (let i = 1; i <= 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
      await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    await page.mouse.up();
    await page.keyboard.up("Shift");
    expect((await studioFrame(page, "cover", "summary")).rotation).toBe(90);
    expect(await history(page)).toBe(before + 2);
    await previewMatches(page, "cover", "summary");
    // Arrows: 1 px and, with Shift, 10 px; one command per press.
    await page.locator('[data-layout-block="summary"]').focus();
    const beforeKeys = await studioFrame(page, "cover", "summary");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    let keyed = await studioFrame(page, "cover", "summary");
    expect([keyed.x, keyed.y]).toEqual([beforeKeys.x + 1, beforeKeys.y + 10]);
    expect(await history(page)).toBe(before + 4);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    keyed = await studioFrame(page, "cover", "summary");
    expect([keyed.x, keyed.y]).toEqual([beforeKeys.x + 1, beforeKeys.y]);
    // Handle and rotation keys.
    await page.locator('[data-handle="e"]').focus();
    await page.keyboard.press("ArrowRight");
    expect((await studioFrame(page, "cover", "summary")).width).toBe(
      keyed.width + 1,
    );
    await page.locator('[data-handle="rotate"]').focus();
    await page.keyboard.press("Shift+ArrowLeft");
    expect((await studioFrame(page, "cover", "summary")).rotation).toBe(75);
    // Numeric fields are the alternative to dragging.
    const field = page.getByRole("textbox", { name: "X frame", exact: true });
    await field.fill("100");
    await field.press("Enter");
    expect((await studioFrame(page, "cover", "summary")).x).toBe(100);
    const height = page.getByRole("textbox", {
      name: "Frame height",
      exact: true,
    });
    await height.fill("5");
    await height.press("Enter");
    await expect(page.locator(".field-error").first()).toBeVisible();
    expect(
      (await studioFrame(page, "cover", "summary")).height,
    ).toBeGreaterThanOrEqual(8);
    const count = await history(page);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await history(page)).toBe(count - 1);
    await previewMatches(page, "cover", "summary");
    if (info.project.name === "chromium")
      await page.screenshot({ path: evidencePath("layout/studio-editor.png") });
  });
  test("align, distribute, layers, reading order, conversion to canvas and back to flow with confirmation", async ({
    page,
  }) => {
    await openStudio(page);
    await openLayout(page);
    await page.getByRole("button", { name: "Select all" }).click();
    await page.getByRole("button", { name: "Align left" }).click();
    let d = await studioDoc(page);
    const lefts = scene(d, "cover").blocks.map((b) => frameBounds(b.frame!).x);
    lefts.forEach((x) => expect(x).toBeCloseTo(Math.min(...lefts), 6));
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    // Three frames distributed horizontally keep equal gaps.
    await page.getByRole("button", { name: "Deselect" }).click();
    for (const id of ["headline", "picture", "stamp"])
      await page
        .locator(`[data-layout-block="${id}"]`)
        .click({ modifiers: ["Shift"] });
    await page.getByRole("button", { name: "Distribute horizontally" }).click();
    d = await studioDoc(page);
    const boxes = ["headline", "picture", "stamp"]
      .map((id) => frameBounds(frame(d, "cover", id)))
      .sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2));
    const gap1 = boxes[1]!.x - (boxes[0]!.x + boxes[0]!.width),
      gap2 = boxes[2]!.x - (boxes[1]!.x + boxes[1]!.width);
    expect(gap1).toBeCloseTo(gap2, 6);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    // Layers: the picture comes to the front and now covers the stamp.
    await page.getByRole("button", { name: "Deselect" }).click();
    await page.locator('[data-layout-block="picture"]').click();
    await page.getByRole("button", { name: "Bring to front" }).click();
    d = await studioDoc(page);
    expect(frame(d, "cover", "picture").z).toBe(5);
    const camera = resolveSceneCamera(d, "cover");
    if (!camera.ok) throw Error();
    const point = await clientPoint(
      page,
      ".preview-player",
      d,
      "cover",
      camera.value,
      [530, 120],
    );
    await expect
      .poll(() =>
        page.evaluate(([x, y]) => {
          const hits = document.elementsFromPoint(x, y);
          return hits
            .find((e) => e.closest(".preview-player [data-block-id]"))
            ?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
        }, point),
      )
      .toBe("picture");
    // Reading order changes the array and the DOM, never frames or z.
    const framesBefore = scene(d, "cover").blocks.map((b) => [b.id, b.frame]);
    await page
      .getByRole("button", { name: "Move block 1 later in reading order" })
      .click();
    d = await studioDoc(page);
    expect(scene(d, "cover").blocks.map((b) => b.id)).toEqual([
      "summary",
      "headline",
      "picture",
      "stamp",
      "note",
    ]);
    expect(
      Object.fromEntries(scene(d, "cover").blocks.map((b) => [b.id, b.frame])),
    ).toEqual(Object.fromEntries(framesBefore));
    await expect
      .poll(() =>
        page
          .locator(
            '.preview-player .xc-scene[data-scene-id="cover"] [data-block-id]',
          )
          .evaluateAll((els) =>
            els.map((e) => (e as HTMLElement).dataset.blockId),
          ),
      )
      .toEqual(["summary", "headline", "picture", "stamp", "note"]);
    // Convert the flow scene: frames from the measured preview rectangles.
    await page
      .getByRole("list", { name: "Scene list" })
      .getByRole("button", { name: /Flow with a plain/ })
      .click();
    await expect(page.locator("[data-layout-block]")).toHaveCount(2);
    // Wait until the preview frames the new scene with the core camera.
    const fitContext = resolveSceneCamera(d, "context");
    if (!fitContext.ok) throw Error();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.studio!.preview!.getState().camera?.position.map(Math.round),
        ),
      )
      .toEqual(fitContext.value.position.map(Math.round));
    const rects = () =>
      page.evaluate(() =>
        ["flow-1", "flow-2"].map((id) =>
          document
            .querySelector(
              `.preview-player .xc-scene[data-scene-id="context"] [data-block-id="${id}"]`,
            )!
            .getBoundingClientRect()
            .toJSON(),
        ),
      );
    await expect.poll(async () => (await rects())[0].width).toBeGreaterThan(0);
    const flowRects = await rects();
    const historyBefore = await history(page);
    await page.getByRole("button", { name: "Convert to canvas" }).click();
    d = await studioDoc(page);
    expect(scene(d, "context").layout).toBe("canvas");
    expect(scene(d, "context").blocks.every((b) => b.frame)).toBe(true);
    expect(await history(page)).toBe(historyBefore + 1);
    const k = await scale(page, "flow-1", frame(d, "context", "flow-1"));
    await expect
      .poll(async () => {
        const now = await rects();
        return Math.max(
          ...now.flatMap((r, i) =>
            (["x", "y", "width", "height"] as const).map(
              (key) => Math.abs(r[key] - flowRects[i]![key]) / k,
            ),
          ),
        );
      })
      .toBeLessThanOrEqual(1.5);
    await page.getByRole("button", { name: "Switch to flow" }).click();
    await expect(page.getByRole("dialog")).toContainText("will be lost");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    expect(scene(await studioDoc(page), "context").layout).toBe("canvas");
    await page.getByRole("button", { name: "Switch to flow" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Switch to flow" })
      .click();
    d = await studioDoc(page);
    expect(scene(d, "context").layout).toBe("flow");
    expect(scene(d, "context").blocks.some((b) => b.frame)).toBe(false);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(frame(await studioDoc(page), "context", "flow-1")).toBeDefined();
  });
  test("theme, appearance and block style edit tokens; clipped text and low contrast are diagnosed", async ({
    page,
  }, info) => {
    await openStudio(page);
    await openLayout(page);
    await page.getByRole("tab", { name: /^Theme/ }).click();
    await page
      .getByRole("combobox", { name: "Body font" })
      .selectOption("system-serif");
    await expect
      .poll(() =>
        page
          .locator(".preview-player .xc-player")
          .evaluate((el) =>
            (el as HTMLElement).style.getPropertyValue("--xc-font-body"),
          ),
      )
      .toContain("serif");
    expect((await studioDoc(page)).theme.fonts.body).toBe("system-serif");
    await page
      .getByRole("combobox", { name: "Text colour" })
      .selectOption("sky");
    await expect(page.locator(".layout-diagnostics")).toContainText(
      "theme text on the background",
    );
    await expect(page.locator(".contrast-list")).toContainText(
      "theme text on the background",
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    // Appearance of the scene, in the scene tab with the scene editor.
    await page.getByRole("tab", { name: /^Scene/ }).click();
    await page
      .getByRole("combobox", { name: "Scene variant" })
      .selectOption("plain");
    await expect(
      page.locator(
        '.preview-player .xc-scene[data-scene-id="cover"] .xc-content',
      ),
    ).toHaveClass(/xc-variant-plain/);
    await page.getByRole("checkbox", { name: /Visible title/ }).check();
    expect(scene(await studioDoc(page), "cover").appearance).toEqual({
      variant: "plain",
      background: null,
      titleVisible: true,
    });
    // Block style on the selected block.
    await page.locator('[data-layout-block="headline"]').click();
    await page.getByRole("combobox", { name: "Text size" }).selectOption("xs");
    await expect(
      page.locator('.preview-player [data-block-id="headline"]'),
    ).toHaveClass(/xc-size-xs/);
    expect(scene(await studioDoc(page), "cover").blocks[0]!.style).toEqual({
      size: "xs",
      color: "rust",
    });
    // Text that exceeds its frame is clipped and reported.
    await page.locator('[data-layout-block="summary"]').click();
    const height = page.getByRole("textbox", {
      name: "Frame height",
      exact: true,
    });
    await height.fill("24");
    await height.press("Enter");
    await expect(page.locator(".layout-diagnostics")).toContainText(
      "Clipped content: block 2",
    );
    // A frame above interactive controls is reported too.
    await page
      .getByRole("list", { name: "Scene list" })
      .getByRole("button", { name: /Columns and links/ })
      .click();
    await page.locator('[data-layout-block="column-a"]').click();
    const y = page.getByRole("textbox", { name: "Y frame", exact: true });
    await y.fill("280");
    await y.press("Enter");
    const z = page.getByRole("textbox", { name: "Z layer", exact: true });
    await z.fill("5");
    await z.press("Enter");
    await expect(page.locator(".layout-diagnostics")).toContainText(
      "block 1 covers the interactive controls of block 3",
    );
    if (info.project.name === "chromium")
      await page.screenshot({
        path: evidencePath("layout/studio-diagnostics.png"),
        fullPage: true,
      });
  });
  test("a canvas title wrapping over frames and a flow scene taller than itself are diagnosed", async ({
    page,
  }) => {
    const d = doc();
    // Four lines of title: the visible title band reaches the columns at y 150.
    scene(d, "details").title = Array(4).fill("Columns and links").join(" · ");
    scene(d, "context").blocks.push({
      id: "long",
      type: "text",
      data: { text: "A line of text that does not fit.\n".repeat(40) },
    });
    await openStudio(page, {
      name: "project.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(d)),
    });
    const scenes = page.getByRole("list", { name: "Scene list" });
    await scenes.getByRole("button", { name: /Columns and links/ }).click();
    await openLayout(page);
    await expect(page.locator(".layout-diagnostics")).toContainText(
      "Title: block 1 overlaps the band of the visible title.",
    );
    await scenes.getByRole("button", { name: /Flow with a plain/ }).click();
    await expect(page.locator(".layout-diagnostics")).toContainText(
      /Content beyond the scene: \d+ px stay outside/,
    );
    // A hidden title takes no band, whatever the frames.
    await scenes.getByRole("button", { name: /Spaces that read/ }).click();
    await expect(page.locator(".layout-diagnostics")).not.toContainText(
      "Title:",
    );
  });
  test("saved JSON and archive reopen in a new session, recover after reload and present in the vanilla player with the same model and landmarks", async ({
    page,
    browser,
  }, info) => {
    await openStudio(page);
    await openLayout(page);
    await page.locator('[data-layout-block="note"]').click();
    for (const [label, value] of [
      ["X frame", "60"],
      ["Frame rotation", "8"],
    ] as const) {
      const field = page.getByRole("textbox", { name: label, exact: true });
      await field.fill(value);
      await field.press("Enter");
    }
    const edited = await studioDoc(page);
    expect(frame(edited, "cover", "note")).toMatchObject({
      x: 60,
      rotation: 8,
    });
    const json = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save JSON", exact: true }).click();
    // Saved with their real names: Studio picks the reader from the extension.
    const jsonPath = evidencePath(`layout/saved-${info.project.name}.json`);
    await (await json).saveAs(jsonPath);
    const zip = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Save archive", exact: true })
      .click();
    const archivePath = evidencePath(
      `layout/saved-${info.project.name}.xcursus`,
    );
    await (await zip).saveAs(archivePath);
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toEqual(edited);
    // Recovery after an unsaved edit.
    await page.locator('[data-layout-block="note"]').focus();
    await page.keyboard.press("ArrowUp");
    const unsaved = await studioDoc(page);
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.getByRole("dialog")).toContainText("Local recovery");
    await page.getByRole("button", { name: "Recover revision" }).click();
    await expect.poll(() => studioDoc(page)).toEqual(unsaved);
    await page.close();
    // A fresh session reopens both files.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const fresh = await context.newPage();
    await fresh.emulateMedia({ reducedMotion: "reduce" });
    await openStudio(fresh, jsonPath);
    expect(await studioDoc(fresh)).toEqual(edited);
    await openStudio(fresh, archivePath);
    expect(await studioDoc(fresh)).toEqual(edited);
    await expect(
      fresh.locator('.preview-player [data-block-id="picture"] img'),
    ).toHaveCount(1);
    // Presenting in Studio uses the same player and the same frames.
    await fresh.getByRole("button", { name: "Present", exact: true }).click();
    await expect(fresh.locator(".presentation-player .xc-player")).toHaveCount(
      1,
    );
    const fit = resolveSceneCamera(edited, "cover");
    if (!fit.ok) throw Error();
    const blocks = scene(edited, "cover").blocks.map((b) => ({
      id: b.id,
      points: locals(b.frame!),
    }));
    const wanted = scene(edited, "cover").blocks.map((b) =>
      expected(edited, "cover", fit.value, b.frame!),
    );
    const presented = await rendered(
      fresh,
      ".presentation-player",
      "cover",
      blocks,
    );
    presented.forEach((points, i) => close(points, wanted[i]!));
    // The vanilla player opens the archive saved by Studio.
    const plain = await context.newPage();
    await plain.emulateMedia({ reducedMotion: "reduce" });
    await vanilla(plain);
    await plain.getByLabel("Open local project").setInputFiles(archivePath);
    await expect(
      plain.getByRole("status").filter({ hasText: "Project opened" }),
    ).toHaveCount(1);
    expect(await plain.evaluate(() => window.demoDocument)).toEqual(edited);
    await plain.evaluate(() =>
      window.demoPlayers[0]!.goTo({ nodeId: "n1" }, { durationMs: 0 }),
    );
    const measured = await rendered(plain, "#player-1", "cover", blocks);
    measured.forEach((points, i) => close(points, wanted[i]!));
    await expect(
      plain.locator('#player-1 [data-block-id="picture"] img'),
    ).toHaveCount(1);
    await writeEvidence(`layout/roundtrip-${info.project.name}.json`, {
      saved: {
        json: jsonPath.split("/").pop(),
        archive: archivePath.split("/").pop(),
      },
      note: frame(edited, "cover", "note"),
      presented,
      vanilla: measured,
      expected: wanted,
    });
    await context.close();
  });
  test("the whole scene editor works from the keyboard with visible focus at 1440 and 768 px", async ({
    browser,
  }, info) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openStudio(page);
      await page.getByRole("button", { name: "Layout", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-layout-block]")).toHaveCount(5);
      await overlayAligned(page, "cover");
      const first = page.locator('[data-layout-block="headline"]');
      await first.focus();
      await page.keyboard.press("Enter");
      await expect(first).toHaveAttribute("aria-pressed", "true");
      const start = await studioFrame(page, "cover", "headline");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute("data-handle"),
      );
      expect(focused).toBe("nw");
      expect(
        await page.evaluate(() =>
          document.activeElement!.matches(":focus-visible"),
        ),
      ).toBe(true);
      await page.keyboard.press("ArrowLeft");
      for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("data-handle"),
        ),
      ).toBe("rotate");
      await page.keyboard.press("ArrowRight");
      const after = await studioFrame(page, "cover", "headline");
      expect(after.x).toBe(start.x - 2);
      expect(after.width).toBe(start.width + 1);
      expect(after.rotation).toBe(1);
      // Delete inside the editor never deletes the scene.
      await page.keyboard.press("Delete");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await first.focus();
      await page.keyboard.press("Escape");
      await expect(first).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator(".layout-live")).not.toBeEmpty();
      if (info.project.name === "chromium")
        await page.screenshot({
          path: evidencePath(`layout/studio-keyboard-${viewport.width}.png`),
        });
      await context.close();
    }
  });
  test("dragging 30 canvas blocks keeps p95 input→preview within 100 ms over 100 gestures", async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(300_000);
    const d = doc();
    const cover = scene(d, "cover");
    cover.blocks = Array.from({ length: 30 }, (_, i) => ({
      id: `b${i}`,
      type: "text" as const,
      data: {
        text: `Block ${i + 1} with a test text of a few words.`,
      },
      frame: {
        x: 20 + (i % 6) * 195,
        y: 20 + Math.floor(i / 6) * 130,
        width: 180,
        height: 110,
        rotation: i % 5 === 0 ? 7 : 0,
        z: i % 3,
      },
      style: { size: "xs" as const },
    }));
    d.scenes = [cover];
    d.paths[0]!.nodes = [d.paths[0]!.nodes[0]!];
    d.paths[0]!.edges = [];
    updateCapabilities(d);
    await openStudio(page, {
      name: "thirty.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(d)),
    });
    await openLayout(page);
    await page.evaluate(() => {
      const marks = { inputs: [] as number[], commits: [] as number[] };
      (window as unknown as { marks: typeof marks }).marks = marks;
      window.studio!.preview!.on("documentchange", () =>
        marks.commits.push(performance.now()),
      );
      // Only moves with a pressed button belong to a gesture.
      document.addEventListener(
        "pointermove",
        (e) => {
          if (e.buttons) marks.inputs.push(performance.now());
        },
        true,
      );
    });
    const raf = () =>
      page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => r(null))),
      );
    const tracing = info.project.name === "chromium";
    if (tracing)
      await browser.startTracing(page, {
        path: evidencePath("layout/perf-trace-chromium.json"),
        screenshots: false,
      });
    const before = await history(page);
    for (let g = 0; g < 100; g++) {
      const target =
        g % 2 === 0 ? '[data-layout-block="b14"]' : '[data-handle="se"]';
      if (g === 1) {
        await page.locator('[data-layout-block="b14"]').focus();
        await page.keyboard.press("Enter");
      }
      const [x, y] = await centre(page, target);
      await page.mouse.move(x, y);
      await page.mouse.down();
      const sign = g % 4 < 2 ? 1 : -1;
      for (let i = 1; i <= 3; i++) {
        await page.mouse.move(x + sign * i * 3, y + sign * i * 2);
        await raf();
      }
      await page.mouse.up();
    }
    await page.waitForTimeout(100);
    if (tracing) await browser.stopTracing();
    const marks = await page.evaluate(
      () =>
        (
          window as unknown as {
            marks: { inputs: number[]; commits: number[] };
          }
        ).marks,
    );
    const latency = marks.inputs
      .map((t) => marks.commits.find((c) => c >= t))
      .map((c, i) => (c === undefined ? Infinity : c - marks.inputs[i]!))
      .sort((a, b) => a - b);
    const p = (q: number) =>
      latency[
        Math.min(latency.length - 1, Math.ceil((q / 100) * latency.length) - 1)
      ]!;
    const summary = {
      browser: info.project.name,
      browserVersion: browser.version(),
      runner: process.env.XCURSUS_E2E_RUNNER,
      ci: !!process.env.CI,
      blocks: 30,
      gestures: 100,
      samples: latency.length,
      p50: p(50),
      p95: p(95),
      max: latency.at(-1),
      commands: (await history(page)) - before,
    };
    await writeEvidence(`layout/perf-${info.project.name}.json`, summary);
    expect(summary.samples).toBeGreaterThanOrEqual(200);
    // History keeps 100 commands: every gesture produced exactly one.
    expect(summary.commands).toBe(100);
    if (!process.env.CI) expect(summary.p95).toBeLessThanOrEqual(100);
  });
});
