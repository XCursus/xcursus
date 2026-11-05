import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import {
  getWorldMatrix,
  cameraPose,
  resolveEdgePlan,
  sampleTransition,
  validateDocument,
  viewMatrix,
} from "../../packages/core/src/index.js";
import type { ProjectDocument } from "../../packages/core/src/index.js";
import fixture from "../../examples/structure-branching/project.json" with { type: "json" };
import legacy from "../../examples/core-three-scenes/project.json" with { type: "json" };
import { test, expect } from "./runner.js";
import { evidencePath, studioURL, writeEvidence } from "./evidence.js";
declare global {
  interface Window {
    structureCueEvents: number;
  }
}
const doc = (input: unknown = fixture) => {
  const r = validateDocument(input);
  if (!r.ok) throw Error(JSON.stringify(r));
  return r.value;
};
async function upload(page: Page, input: unknown = fixture) {
  await page.getByLabel("JSON project file").setInputFiles({
    name: "structure.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(input)),
  });
}
async function number(page: Page, label: string, text: string) {
  await page.getByRole("textbox", { name: label, exact: true }).fill(text);
  await page.getByRole("textbox", { name: label, exact: true }).press("Tab");
}
async function studio(page: Page) {
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  await upload(page);
  await expect(page.getByLabel("Project title")).toHaveValue(
    "Branches, hierarchy and camera",
  );
}
async function points(page: Page, host: string, sceneId: string) {
  return page.evaluate(
    ({ host, sceneId }) => {
      const player = document.querySelector(host)!,
        wrapper = player.querySelector<HTMLElement>(
          `.xc-scene[data-scene-id="${sceneId}"]`,
        )!,
        stage = player.querySelector(".xc-stage")!.getBoundingClientRect(),
        fit = Math.min(stage.width / 1280, stage.height / 720);
      return [
        [-150, -80],
        [0, 0],
        [200, 100],
      ].map(([x, y]) => {
        const marker = document.createElement("i");
        marker.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
        wrapper.append(marker);
        const b = marker.getBoundingClientRect();
        marker.remove();
        return [
          (b.x - stage.x - stage.width / 2) / fit,
          (b.y - stage.y - stage.height / 2) / fit,
        ];
      });
    },
    { host, sceneId },
  );
}
function projected(
  document: ProjectDocument,
  sceneId: string,
  camera: Parameters<typeof viewMatrix>[0],
) {
  const world = getWorldMatrix(document, sceneId);
  if (!world.ok) throw Error();
  const v = viewMatrix(camera),
    m = world.value;
  return [
    [-150, -80],
    [0, 0],
    [200, 100],
  ].map(([x, y]) => {
    const w = [0, 1, 2, 3].map((i) => m[i]! * x! + m[i + 4]! * y! + m[i + 12]!);
    const p = [0, 1, 2].map(
      (i) => v[i]! * w[0]! + v[i + 4]! * w[1]! + v[i + 8]! * w[2]! + v[i + 12]!,
    );
    const perspective = 1 - p[2]! / document.settings.viewport.perspective;
    return [p[0]! / perspective, p[1]! / perspective];
  });
}
const close = (a: number[][], b: number[][]) =>
  a.forEach((point, i) =>
    point.forEach((n, j) =>
      expect(Math.abs(n - b[i]![j]!)).toBeLessThanOrEqual(1),
    ),
  );
test("vanilla branch choices, actual prev poses, manual loop limits and keyboard focus are shared across instances", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/structure");
  const host = page.locator("#player-1");
  await expect(host.locator(".xc-live")).toContainText(
    "Choose the path. Explore B; Explore C",
  );
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().nodeId),
  ).toBe("A");
  const initial = await page.evaluate(() => window.demoPlayers[0]!.getState());
  expect(
    (await page.evaluate(() => window.demoPlayers[0]!.next())).status,
  ).toBe("choice-required");
  expect(await page.evaluate(() => window.demoPlayers[0]!.getState())).toEqual(
    initial,
  );
  await host.getByRole("button", { name: "Explore B", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(host.locator('[data-scene-id="B"] h2')).toBeFocused();
  await expect(host.locator(".xc-live")).not.toContainText("Explore C");
  const endpoint = cameraPose(doc().cameraTracks[0]!.keyframes.at(-1)!.pose);
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().camera),
  ).toEqual(endpoint);
  await host
    .getByRole("button", { name: "Conclusion from B", exact: true })
    .click();
  await page.evaluate(() => window.demoPlayers[0]!.prev());
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().nodeId),
  ).toBe("B");
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().camera),
  ).toEqual(endpoint);
  await page.evaluate(() => window.demoPlayers[0]!.setPath("branch"));
  for (const label of [
    "Explore C",
    "Conclusion from C",
    "Repeat (at most 2 visits)",
    "Explore B",
    "Conclusion from B",
  ])
    await host.getByRole("button", { name: label, exact: true }).click();
  await expect(
    host.getByRole("button", { name: /Repeat.*Limit/ }),
  ).toBeDisabled();
  await expect(host.locator(".xc-live")).toContainText("Limit");
  await host.focus();
  await page.keyboard.press("ArrowRight");
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().nodeId),
  ).toBe("D");
  await page.keyboard.press("ArrowLeft");
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().nodeId),
  ).toBe("B");
  expect(
    await page.evaluate(() => window.demoPlayers[1]!.getState().nodeId),
  ).toBe("A");
  await host.getByRole("button", { name: "Text view", exact: true }).click();
  expect(await host.locator(".xc-outline button").count()).toBe(4);
});
test("nested world landmarks and independent track endpoint render within 1 CSS pixel", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/structure");
  await page.evaluate(() => window.demoPlayers[0]!.next({ edgeId: "AB" }));
  const camera = await page.evaluate(
    () => window.demoPlayers[0]!.getState().camera!,
  );
  const landmarks = await points(page, "#player-1", "B");
  close(landmarks, projected(doc(), "B", camera));
  if (info.project.name === "chromium") {
    await page.locator("#player-1").screenshot({
      path: evidencePath("regressions/structure-nested.png"),
    });
    await writeEvidence(
      "regressions/structure-landmarks.json",
      JSON.stringify(
        { camera, landmarks, expected: projected(doc(), "B", camera) },
        null,
        2,
      ) + "\n",
    );
  }
});
test("Studio reparent preserves real geometry; alternative graph, save and reopen retain 1.1.0 data", async ({
  page,
  browser,
}, info) => {
  await studio(page);
  await page
    .getByRole("list", { name: "Scene list" })
    .getByRole("button", { name: /B · Child/ })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().nodeId))
    .toBe("B");
  const before = await points(page, ".preview-player", "B");
  await page.getByText("Spatial hierarchy", { exact: true }).click();
  await page.getByLabel("Scene parent", { exact: true }).selectOption("C");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window
            .studio!.store.getSnapshot()
            .document.scenes.find((s) => s.id === "B")!.parentId,
      ),
    )
    .toBe("C");
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().status))
    .toBe("idle");
  close(await points(page, ".preview-player", "B"), before);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window
          .studio!.store.getSnapshot()
          .document.scenes.find((s) => s.id === "B")!.parentId,
    ),
  ).toBe("A");
  await page.getByRole("tab", { name: /^Paths/ }).click();
  await page.getByRole("button", { name: "New path", exact: true }).click();
  await page
    .getByLabel("Path name", { exact: true })
    .fill("Reading from Studio");
  await page.getByLabel("Path name", { exact: true }).press("Tab");
  for (const scene of ["A", "C", "D"]) {
    await page.getByLabel("Scene to add to the path").selectOption(scene);
    await page.getByRole("button", { name: "Add visit", exact: true }).click();
  }
  const path = await page.evaluate(() =>
    window.studio!.store.getSnapshot().document.paths.at(-1)!,
  );
  await page
    .getByLabel("Connection from", { exact: true })
    .selectOption(path.nodes[0]!.id);
  await page
    .getByLabel("Connection to", { exact: true })
    .selectOption(path.nodes[2]!.id);
  await page.getByRole("button", { name: "Link nodes", exact: true }).click();
  await page
    .getByLabel("Choice label", { exact: true })
    .fill("Direct choice D");
  await page.getByLabel("Choice label", { exact: true }).press("Tab");
  const expected = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save JSON", exact: true }).click();
  const file = await download,
    pathToFile = (await file.path())!;
  const saved = JSON.parse(
    await readFile(pathToFile, "utf8"),
  ) as ProjectDocument;
  expect(saved).toEqual(expected);
  expect(saved.schemaVersion).toBe("1.3.0");
  const context = await browser.newContext(),
    fresh = await context.newPage();
  await fresh.goto(studioURL);
  await upload(fresh, saved);
  await expect
    .poll(() =>
      fresh.evaluate(() => window.studio!.store.getSnapshot().document),
    )
    .toEqual(expected);
  if (info.project.name === "chromium") {
    await writeEvidence(
      "regressions/structure-roundtrip.json",
      JSON.stringify(saved, null, 2) + "\n",
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: evidencePath("regressions/structure-studio.png"),
    });
  }
  await context.close();
});
test("timeline editing and scrub use the actual preview sampler with no visits or cues", async ({
  page,
}, info) => {
  await studio(page);
  await page.getByRole("tab", { name: /^Paths/ }).click();
  await page
    .getByRole("list", { name: "Path connections" })
    .getByRole("button", { name: /Explore B/ })
    .click();
  const updated = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const off = window.studio!.preview!.on("documentchange", () => {
          off();
          resolve();
        });
      }),
  );
  await number(page, "Keyframe 2 position Y", "-500");
  await updated;
  const document = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  expect(document.cameraTracks[0]!.keyframes[1]!.pose.position[1]).toBe(-500);
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().status))
    .toBe("idle");
  const before = await page.evaluate(() => {
    window.structureCueEvents = 0;
    window.studio!.preview!.on("cue", () => window.structureCueEvents++);
    return window.studio!.preview!.getState().history;
  });
  const slider = page.getByRole("slider", { name: "Scrub camera" });
  await slider.focus();
  await slider.press("Home");
  for (let i = 0; i < 5; i++) await slider.press("PageUp");
  const progress = Number(await slider.inputValue()) / 1000;
  expect(progress).toBeGreaterThan(0);
  expect(progress).toBeLessThan(1);
  const result = resolveEdgePlan(document, "branch", "AB");
  if (!result.ok) throw Error();
  const expected = sampleTransition(result.value, progress * 1200).camera;
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().camera))
    .toEqual(expected);
  expect(
    await page.evaluate(() => window.studio!.preview!.getState().history),
  ).toEqual(before);
  close(
    await points(page, ".preview-player", "B"),
    projected(document, "B", expected),
  );
  expect(await page.evaluate(() => window.structureCueEvents)).toBe(0);
  await slider.press("End");
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().camera))
    .toEqual(cameraPose(document.cameraTracks[0]!.keyframes.at(-1)!.pose));
  expect(
    await page.evaluate(() => window.studio!.preview!.getState().history),
  ).toEqual(before);
  if (info.project.name === "chromium") {
    await page.locator(".preview-player").screenshot({
      path: evidencePath("regressions/structure-track.png"),
    });
    await page.locator(".timeline-panel").screenshot({
      path: evidencePath("regressions/structure-timeline.png"),
    });
  }
  await page
    .getByRole("button", { name: "End camera inspection", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().camera))
    .toEqual(before.at(-1)!.camera);
});
test("historic JSON opens as migrated copy, future versions preserve active work and autosave recovers structure", async ({
  page,
}) => {
  await page.goto(studioURL);
  await upload(page, legacy);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.studio!.store.getSnapshot().document.schemaVersion,
      ),
    )
    .toBe("1.3.0");
  expect(
    await page.evaluate(() =>
      window
        .studio!.store.getSnapshot()
        .document.scenes.every((s) => s.parentId === null),
    ),
  ).toBe(true);
  await upload(page, { ...fixture, schemaVersion: "1.4.0" });
  await expect(page.getByRole("alert")).toContainText("Supported schemas");
  expect(
    await page.evaluate(
      () => window.studio!.store.getSnapshot().document.scenes[0]!.id,
    ),
  ).toBe("intro");
  await upload(page, fixture);
  await page.getByLabel("Project title").fill("Struttura recuperata");
  await page.getByLabel("Project title").press("Tab");
  await page.evaluate(
    () => new Promise((resolve) => setTimeout(resolve, 1000)),
  );
  const expected = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Recover revision", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.studio!.store.getSnapshot().document),
    )
    .toEqual(expected);
});
test("overview, pan, zoom and direct goTo keep history and mobile controls usable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/structure");
  const host = page.locator("#player-1"),
    before = await page.evaluate(
      () => window.demoPlayers[0]!.getState().history,
    );
  await host.getByRole("button", { name: "Overview", exact: true }).click();
  const overview = await page.evaluate(
    () => window.demoPlayers[0]!.getState().camera!,
  );
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().history),
  ).toEqual(before);
  await host.getByText("Camera", { exact: true }).click();
  await host.getByRole("button", { name: "Pan right", exact: true }).click();
  expect(
    (await page.evaluate(() => window.demoPlayers[0]!.getState().camera!))
      .position[0],
  ).toBeGreaterThan(overview.position[0]);
  await host.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(
    (await page.evaluate(() => window.demoPlayers[0]!.getState().camera!)).zoom,
  ).toBeGreaterThan(overview.zoom);
  await page.evaluate(() =>
    window.demoPlayers[0]!.goTo({ pathId: "alternate", nodeId: "alt-D" }),
  );
  expect(
    (await page.evaluate(() => window.demoPlayers[0]!.getState())).history.map(
      (v) => v.nodeId,
    ),
  ).toEqual(["alt-D"]);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(studioURL);
  await upload(page);
  await page.getByRole("tab", { name: /^Paths/ }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("Studio creates a real camera track, node pose and declarative cue through controls", async ({
  page,
}) => {
  await studio(page);
  await page.getByRole("tab", { name: /^Paths/ }).click();
  await page.getByLabel("Path to edit").selectOption("alternate");
  await page
    .getByRole("button", { name: "Independent camera", exact: true })
    .click();
  await number(page, "Node position Z", "-220");
  await page
    .getByRole("button", { name: "Create a three-keyframe track", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Camera keyframes" }).locator("li"),
  ).toHaveCount(3);
  await number(page, "Keyframe 2 position X", "-500");
  await page.getByLabel("Position interpolation").selectOption("cubic");
  await page
    .getByLabel("Track easing", { exact: true })
    .selectOption("ease-in-out");
  await page.getByRole("button", { name: "Add cue", exact: true }).click();
  await page
    .getByRole("textbox", { name: /Cue event/ })
    .fill("presentation.note");
  await page.getByRole("textbox", { name: /Cue event/ }).press("Tab");
  await page
    .getByRole("textbox", { name: /Payload cue/ })
    .fill('{"note":"dichiarativo"}');
  await page.getByRole("textbox", { name: /Payload cue/ }).press("Tab");
  const result = await page.evaluate(
      () => window.studio!.store.getSnapshot().document,
    ),
    path = result.paths.find((p) => p.id === "alternate")!,
    track = result.cameraTracks.find(
      (t) => t.id === path.edges[0]!.cameraTrackId,
    )!;
  expect(path.nodes[0]!.camera!.position[2]).toBe(-220);
  expect(track.keyframes).toHaveLength(3);
  expect(track.keyframes[1]!.pose.position[0]).toBe(-500);
  expect(result.cues.find((c) => c.edgeId === "alt-CD")!.payload).toEqual({
    note: "dichiarativo",
  });
  expect(validateDocument(result).ok).toBe(true);
});
test("Studio loop policy, graph deletion impact and undo restore all references atomically", async ({
  page,
}) => {
  await studio(page);
  await page.getByRole("tab", { name: /^Paths/ }).click();
  await page.getByLabel("Path to edit").selectOption("alternate");
  await page
    .getByRole("button", {
      name: "Enable manual loop (3 visits)",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Connection from", { exact: true })
    .selectOption("alt-D");
  await page.getByLabel("Connection to", { exact: true }).selectOption("alt-C");
  await page.getByRole("button", { name: "Link nodes", exact: true }).click();
  const loop = await page.evaluate(() =>
    window
      .studio!.store.getSnapshot()
      .document.paths.find((p) => p.id === "alternate")!,
  );
  expect(loop.loopPolicy!.maxVisitsPerNode).toBe(3);
  expect(loop.edges.every((e) => e.condition?.kind === "manual")).toBe(true);
  // The limit field shows its whole value next to «Rimuovi policy loop».
  const limit = page.getByLabel("Visit limit per node", { exact: true });
  await expect(limit).toHaveValue("3");
  const field = await limit.evaluate((input: HTMLInputElement) => ({
    width: input.clientWidth,
    clipped: input.scrollWidth > input.clientWidth,
  }));
  expect(field.width).toBeGreaterThanOrEqual(48);
  expect(field.clipped).toBe(false);
  await page.getByLabel("Path to edit").selectOption("branch");
  const before = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  await page.getByRole("button", { name: "Delete path", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("4 visits");
  await expect(page.getByRole("dialog")).toContainText("3 cue");
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .last()
    .click();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);
  await page.getByRole("button", { name: "Delete path", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete structure", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => window.studio!.store.getSnapshot().document.defaultPathId,
    ),
  ).toBe("alternate");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);
});
