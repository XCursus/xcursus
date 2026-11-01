import { readFile } from "node:fs/promises";
import {
  resolveSceneCamera,
  validateDocument,
} from "../../packages/core/src/index.js";
import type { ProjectDocument } from "../../packages/core/src/index.js";
import type { Page } from "@playwright/test";
import { expect, test } from "./runner.js";
import { evidencePath, studioURL, writeEvidence } from "./evidence.js";
import fixture from "../../examples/editor-roundtrip/project.json" with { type: "json" };
async function open(page: Page) {
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
}
async function upload(page: Page, document: unknown = fixture) {
  await page.getByLabel("JSON project file").setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
}
async function number(page: Page, label: string, value: string) {
  await page.getByRole("textbox", { name: label, exact: true }).fill(value);
  await page.getByRole("textbox", { name: label, exact: true }).press("Tab");
}
async function landmarks(page: Page, present = false) {
  return page.evaluate((present) => {
    const host = document.querySelector(
      present ? ".presentation-player" : ".preview-player",
    )!;
    const wrapper = host.querySelector<HTMLElement>(
        '.xc-scene[data-active="true"]',
      )!,
      stage = host.querySelector(".xc-stage")!.getBoundingClientRect();
    const fit = Math.min(stage.width / 1280, stage.height / 720);
    return [
      [-150, -80],
      [0, 0],
      [200, 100],
    ].map(([x, y]) => {
      const marker = document.createElement("i");
      marker.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
      wrapper.append(marker);
      const box = marker.getBoundingClientRect();
      marker.remove();
      return [
        (box.x - stage.x - stage.width / 2) / fit,
        (box.y - stage.y - stage.height / 2) / fit,
      ];
    });
  }, present);
}
test("editor → real JSON download → new browser session → player preserves model, camera and landmarks", async ({
  page,
  browser,
}, info) => {
  await open(page);
  for (let i = 1; i <= 3; i++) {
    await page.getByRole("button", { name: "New scene", exact: true }).click();
    await page.getByLabel("Scene title", { exact: true }).fill(`Idea ${i}`);
    await page.getByLabel("Scene title", { exact: true }).press("Tab");
  }
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(3);
  await page.getByRole("button", { name: /Idea 2/ }).click();
  const selected = await page.evaluate(
    () => window.studio!.store.getSnapshot().selection,
  );
  const rect = page.locator(`[data-map-scene="${selected}"] rect`),
    box = (await rect.boundingBox())!;
  const before = await page.evaluate(
    () => window.studio!.store.getSnapshot().historyLength,
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 55,
    box.y + box.height / 2 + 30,
    { steps: 12 },
  );
  await page.mouse.up();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().historyLength),
  ).toBe(before + 1);
  for (const [label, value] of [
    ["X", "333"],
    ["Y", "-120"],
    ["Z", "175"],
    ["Rotation X", "12"],
    ["Rotation Y", "23"],
    ["Rotation Z", "34"],
    ["Scale", "1.4"],
    ["Width", "880"],
    ["Height", "500"],
  ])
    await number(page, label!, value!);
  await number(page, "X", "555");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "X", exact: true }),
  ).toHaveValue("333");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "X", exact: true }),
  ).toHaveValue("555");
  await page
    .getByLabel("Text 1", { exact: true })
    .fill("A way of thinking in space <script>literal</script>");
  await page.getByLabel("Text 1", { exact: true }).press("Tab");
  await page
    .getByLabel("Speaker notes")
    .fill("Private note, kept in the document.");
  await page.getByLabel("Speaker notes").press("Tab");
  const document = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().camera))
    .toEqual(
      (resolveSceneCamera(document, selected!) as { ok: true; value: unknown })
        .value,
    );
  const camera = await page.evaluate(
      () => window.studio!.preview!.getState().camera,
    ),
    points = await landmarks(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save JSON", exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = (await download.path())!;
  const saved = JSON.parse(
    await readFile(downloadPath, "utf8"),
  ) as ProjectDocument;
  expect(saved).toEqual(document);
  expect(saved.schemaVersion).toBe("1.3.0");
  if (info.project.name === "chromium")
    await page.screenshot({
      path: evidencePath("regressions/editor-desktop.png"),
      fullPage: true,
    });
  await page.close();
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    reopened = await context.newPage();
  await open(reopened);
  await reopened.getByLabel("JSON project file").setInputFiles(downloadPath);
  await expect
    .poll(() =>
      reopened.evaluate(() => window.studio!.store.getSnapshot().document),
    )
    .toEqual(saved);
  await reopened.getByRole("button", { name: /Idea 2/ }).click();
  await expect
    .poll(() =>
      reopened.evaluate(() => window.studio!.preview!.getState().camera),
    )
    .toEqual(camera);
  const reopenedPoints = await landmarks(reopened);
  for (let i = 0; i < points.length; i++)
    for (let j = 0; j < 2; j++)
      expect(Math.abs(points[i]![j]! - reopenedPoints[i]![j]!)).toBeLessThan(1);
  await reopened.getByRole("button", { name: "Present", exact: true }).click();
  const nodeId = saved.paths[0]!.nodes.find((n) => n.sceneId === selected)!.id;
  await reopened.evaluate(async (nodeId) => {
    await window.studio!.presentation!.goTo({ nodeId }, { durationMs: 0 });
  }, nodeId);
  expect(
    await reopened.evaluate(
      () => window.studio!.presentation!.getState().camera,
    ),
  ).toEqual(camera);
  const presentedPoints = await landmarks(reopened, true);
  for (let i = 0; i < points.length; i++)
    for (let j = 0; j < 2; j++)
      expect(Math.abs(points[i]![j]! - presentedPoints[i]![j]!)).toBeLessThan(
        1,
      );
  if (info.project.name === "chromium") {
    await writeEvidence(
      "regressions/editor-roundtrip-saved.json",
      JSON.stringify(saved, null, 2) + "\n",
    );
    await writeEvidence(
      "regressions/editor-roundtrip-evidence.json",
      JSON.stringify(
        {
          camera,
          selectedScene: selected,
          previewLandmarks: points,
          reopenedLandmarks: reopenedPoints,
          presentationLandmarks: presentedPoints,
          toleranceCssPixels: 1,
          documentEqual: true,
          schemaVersion: saved.schemaVersion,
        },
        null,
        2,
      ) + "\n",
    );
  }
  await reopened.keyboard.press("Escape");
  await expect(
    reopened.getByRole("button", { name: "Present", exact: true }),
  ).toBeFocused();
  expect(
    await reopened.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(saved);
  await context.close();
});
test("real IndexedDB reload offers recovery; ten revisions retained and stale writers conflict atomically", async ({
  page,
}, info) => {
  await open(page);
  await upload(page);
  await page.getByLabel("Speaker notes").fill("Recovered note");
  await page.getByLabel("Speaker notes").press("Tab");
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.studio!.repository.heads()).length,
      ),
    )
    .toBe(1);
  const saved = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole("dialog")).toBeVisible();
  if (info.project.name === "chromium")
    await page.screenshot({
      path: evidencePath("regressions/editor-recovery.png"),
      fullPage: true,
    });
  expect(
    await page.evaluate(
      () => window.studio!.store.getSnapshot().document.scenes.length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Recover revision" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.studio!.store.getSnapshot().document),
    )
    .toEqual(saved);
  const result = await page.evaluate(async () => {
    const repo = window.studio!.repository;
    const head = (await repo.heads())[0]!;
    let last = head;
    for (let i = 0; i < 12; i++)
      last = await repo.save(head.document, last.revision);
    let conflict = false;
    try {
      await repo.save(head.document, head.revision);
    } catch {
      conflict = true;
    }
    return {
      revisions: (await repo.revisions(head.projectId)).map((r) => r.revision),
      latest: (await repo.heads())[0]!.revision,
      last: last.revision,
      conflict,
    };
  });
  expect(result.revisions).toHaveLength(10);
  expect(result.revisions[0]).toBe(result.last);
  expect(result.latest).toBe(result.last);
  expect(result.conflict).toBe(true);
  if (info.project.name === "chromium")
    await writeEvidence(
      "regressions/editor-storage-evidence.json",
      JSON.stringify(result, null, 2) + "\n",
    );
});
test("two tabs detect concurrent revisions and keep the losing document downloadable", async ({
  page,
  context,
}) => {
  await open(page);
  await upload(page);
  await page.getByLabel("Speaker notes").fill("first tab");
  await page.getByLabel("Speaker notes").press("Tab");
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.studio!.repository.heads()).length,
      ),
    )
    .toBe(1);
  const second = await context.newPage();
  await open(second);
  await second.getByRole("button", { name: "Recover revision" }).click();
  await page.getByLabel("Speaker notes").fill("winner");
  await page.getByLabel("Speaker notes").press("Tab");
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.studio!.repository.heads())[0]!.document.scenes[0]!
            .notes,
      ),
    )
    .toBe("winner");
  await second.getByLabel("Speaker notes").fill("loser kept in memory");
  await second.getByLabel("Speaker notes").press("Tab");
  await expect(second.locator(".warning")).toContainText("Another tab");
  expect(
    await second.evaluate(
      () => window.studio!.store.getSnapshot().document.scenes[0]!.notes,
    ),
  ).toBe("loser kept in memory");
  const dl = second.waitForEvent("download");
  await second.getByRole("button", { name: "Save JSON", exact: true }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.json$/);
});
test("denied IndexedDB and quota failure keep document, manual save, and atomic heads/recovery", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await open(page);
  await expect(page.locator(".warning")).toContainText("Recovery unavailable");
  await page.getByRole("button", { name: "New scene", exact: true }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save JSON", exact: true }).click();
  await dl;
  await expect(page.locator(".warning")).toContainText("Save JSON");
});
test("quota injection rolls back documents and recovery in the same real transaction", async ({
  page,
}) => {
  await open(page);
  await upload(page);
  const result = await page.evaluate(async () => {
    const repo = window.studio!.repository,
      doc = window.studio!.store.getSnapshot().document;
    const first = await repo.save(doc, 0);
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === "recovery")
        throw new DOMException("quota", "QuotaExceededError");
      return original.apply(this, args);
    };
    let rejected = false;
    try {
      await repo.save(
        { ...doc, metadata: { ...doc.metadata, title: "must roll back" } },
        first.revision,
      );
    } catch {
      rejected = true;
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    return {
      rejected,
      head: (await repo.heads())[0],
      revisions: await repo.revisions(doc.id),
    };
  });
  expect(result.rejected).toBe(true);
  expect(result.head!.revision).toBe(1);
  expect(result.head!.document.metadata.title).toBe(fixture.metadata.title);
  expect(result.revisions).toHaveLength(1);
});
test("invalid JSON, cancel dirty open, number errors, drag Escape, duplicate/delete undo preserve active work", async ({
  page,
}) => {
  await open(page);
  await upload(page);
  await page.getByLabel("Speaker notes").fill("active");
  await page.getByLabel("Speaker notes").press("Tab");
  const before = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  await page.getByLabel("JSON project file").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("bad json"),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);
  await upload(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .last()
    .click();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);
  await number(page, "Scale", "0");
  await expect(
    page.getByRole("textbox", { name: "Scale", exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);
  await page
    .getByRole("textbox", { name: "Scale", exact: true })
    .press("Escape");
  const rect = page.locator('[data-map-scene="intro"] rect'),
    box = (await rect.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 20,
    box.y + box.height / 2 + 20,
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);
  await page
    .getByRole("button", { name: "Duplicate scene", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(4);
  await page.getByRole("button", { name: "Delete scene", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete scene", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(4);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(before);
});
test("essential authoring workflow is keyboard-only, including file open/save and present return", async ({
  page,
}) => {
  await open(page);
  // Reach every control through Tab and activate through the keyboard, without pointer or focus APIs.
  async function reach(label: string, role = "button", reverse = false) {
    for (let i = 0; i < 100; i++) {
      const target = page.getByRole(role as "button", {
        name: label,
        exact: true,
      });
      if (
        await target
          .evaluate((el) => el === document.activeElement)
          .catch(() => false)
      )
        return;
      await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
    }
    throw new Error(`Keyboard did not reach ${label}`);
  }
  for (let i = 0; i < 3; i++) {
    await reach("New scene");
    await page.keyboard.press("Enter");
  }
  await reach("X", "textbox");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("250");
  await page.keyboard.press("Tab");
  await reach("Text 1", "textbox");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Keyboard text");
  await page.keyboard.press("Tab");
  await reach("Speaker notes", "textbox");
  await page.keyboard.type("Keyboard notes");
  await page.keyboard.press("Tab");
  await reach("Undo", "button", true);
  await page.keyboard.press("Enter");
  await reach("Redo");
  await page.keyboard.press("Enter");
  const model = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  const dl = page.waitForEvent("download");
  await page.keyboard.press("ControlOrMeta+s");
  const path = (await (await dl).path())!;
  await reach("Open", "button", true);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(path);
  await expect
    .poll(() =>
      page.evaluate(() => window.studio!.store.getSnapshot().document),
    )
    .toEqual(model);
  await reach("Present");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(model);
});
test("tablet and mobile remain usable, collapsible panels and reduced motion presentation", async ({
  page,
}, info) => {
  await open(page);
  await upload(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "Present", exact: true }),
    ).toBeVisible();
    if (width === 390 && info.project.name === "chromium")
      await page.screenshot({
        path: evidencePath("regressions/editor-mobile.png"),
        fullPage: true,
      });
  }
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.locator(".presentation-player").focus();
  await page.keyboard.press("ArrowRight");
  expect(
    await page.evaluate(() => window.studio!.presentation!.getState().status),
  ).toBe("idle");
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(
    (validateDocument(fixture) as { ok: true; value: ProjectDocument }).value,
  );
});
test("player updateDocument validates atomically, cancels transitions and rebuilds same instance without focus theft", async ({
  page,
}) => {
  await open(page);
  await upload(page);
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().nodeId))
    .toBe("n1");
  const result = await page.evaluate(async () => {
    const player = window.studio!.preview!,
      before = player.getState();
    const invalid = await player.updateDocument({ bad: true });
    const unchanged =
      JSON.stringify(player.getState()) === JSON.stringify(before);
    let changes = 0,
      cancels = 0;
    const off = player.on("documentchange", () => changes++),
      cancel = player.on("navigationcancel", () => cancels++);
    const doc = window.studio!.store.getSnapshot().document;
    for (let i = 0; i < 30; i++) await player.updateDocument(doc);
    off();
    await player.updateDocument(doc);
    cancel();
    return {
      invalid: invalid.ok,
      unchanged,
      changes,
      cancels,
      history: player.getState().history.length,
      count: document.querySelectorAll(".preview-player .xc-player").length,
    };
  });
  expect(result).toEqual({
    invalid: false,
    unchanged: true,
    changes: 30,
    cancels: 0,
    history: 1,
    count: 1,
  });
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const state = await page.evaluate(async () => {
    const player = window.studio!.presentation!,
      doc = structuredClone(window.studio!.store.getSnapshot().document);
    let ghost = 0;
    player.on("scenechange", () => ghost++);
    const pending = player.next();
    doc.paths[0]!.nodes.splice(1);
    doc.paths[0]!.edges = [];
    doc.scenes.splice(1);
    const update = await player.updateDocument(doc);
    return {
      update: update.ok,
      status: (await pending).status,
      ghost,
      state: player.getState(),
    };
  });
  expect(state.update).toBe(true);
  expect(state.status).toBe("cancelled");
  expect(state.ghost).toBe(0);
  expect(state.state.history).toHaveLength(1);
});
test("preview coalesces edits, preserves input focus and disposes players when closed", async ({
  page,
}) => {
  await open(page);
  await upload(page);
  await expect
    .poll(() => page.evaluate(() => window.studio!.preview!.getState().nodeId))
    .toBe("n1");
  await page.getByLabel("Speaker notes").focus();
  const result = await page.evaluate(async () => {
    const player = window.studio!.preview!;
    let changes = 0;
    const off = player.on("documentchange", () => changes++);
    for (let i = 0; i < 30; i++)
      window.studio!.store.execute((document) => {
        document.scenes[0]!.position[0] = i;
        return { ok: true, value: document, diagnostics: [] };
      });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
    );
    off();
    return {
      changes,
      focused: document.activeElement?.getAttribute("aria-label"),
      pose: player.getState().camera!.position,
    };
  });
  expect(result.changes).toBeLessThanOrEqual(1);
  expect(result.changes).toBeGreaterThan(0);
  expect(result.focused).toBe("Speaker notes");
  expect(result.pose[0]).toBe(29);
  const disposed = await page.evaluate(() => {
    const player = window.studio!.preview!;
    (window as unknown as { previousPlayer: unknown }).previousPlayer = player;
    return player.getState().status;
  });
  expect(disposed).toBe("idle");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            previousPlayer: { getState: () => { status: string } };
          }
        ).previousPlayer.getState().status,
    ),
  ).toBe("destroyed");
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(0);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
});
test("player invalid update during transition leaves it running, active deletion resets to start and then empty", async ({
  page,
}) => {
  await open(page);
  await upload(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const result = await page.evaluate(async () => {
    const player = window.studio!.presentation!,
      doc = structuredClone(window.studio!.store.getSnapshot().document);
    const pending = player.next();
    const before = player.getState();
    const invalid = await player.updateDocument({ schemaVersion: "oops" });
    const unchanged =
      JSON.stringify(before) === JSON.stringify(player.getState());
    await player.updateDocument(doc);
    await pending;
    await player.goTo({ nodeId: "n2" }, { durationMs: 0 });
    doc.scenes.splice(1, 1);
    doc.paths[0]!.nodes.splice(1, 1);
    doc.paths[0]!.edges = [{ ...doc.paths[0]!.edges[0]!, to: "n3" }];
    await player.updateDocument(doc);
    const afterDelete = player.getState();
    doc.scenes = [];
    doc.paths = [];
    doc.defaultPathId = null;
    await player.updateDocument(doc);
    return {
      invalid: invalid.ok,
      unchanged,
      start: afterDelete.nodeId,
      history: afterDelete.history.length,
      empty: player.getState(),
    };
  });
  expect(result.invalid).toBe(false);
  expect(result.unchanged).toBe(true);
  expect(result.start).toBe("n1");
  expect(result.history).toBe(1);
  expect(result.empty.status).toBe("empty");
  expect(result.empty.history).toEqual([]);
  await expect(page.locator(".presentation-player .xc-empty")).toBeVisible();
});
test("save shortcut commits the focused text draft before downloading the validated snapshot", async ({
  page,
}) => {
  await open(page);
  await upload(page);
  await page.getByLabel("Speaker notes").fill("Still focused when saving");
  const download = page.waitForEvent("download");
  await page.keyboard.press("ControlOrMeta+s");
  const saved = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  ) as ProjectDocument;
  expect(saved.scenes[0]!.notes).toBe("Still focused when saving");
  expect(
    await page.evaluate(() => window.studio!.store.getSnapshot().document),
  ).toEqual(saved);
});
