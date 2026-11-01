import { readFile } from "node:fs/promises";
import { expect, test } from "./runner.js";
import { studioURL, writeEvidence } from "./evidence.js";
import type { Page } from "@playwright/test";

// The native .xcursus archive and the import of legacy .spatialdeck archives
// in production Studio and in the vanilla playground.
const legacy = "tests/fixtures/legacy/layout-canvas.spatialdeck";
const current = "examples/layout-canvas/layout-canvas.xcursus";
const snapshot = (page: Page) =>
  page.evaluate(() => window.studio!.store.getSnapshot().document);
/** Opens archive bytes with the library reader on /content: schema and asset digests. */
async function inspect(page: Page, bytes: Buffer) {
  await page.goto("/content");
  await expect(page.locator(".xc-player")).toHaveCount(2);
  return page.evaluate(async (base64) => {
    const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const archive = await window.contentAPI.readArchive(new Blob([data]));
    const assets: Record<string, string> = {};
    for (const [id, blob] of archive.blobs) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await blob.arrayBuffer(),
      );
      assets[id] = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    return {
      document: archive.document,
      sourceSchemaVersion: archive.sourceSchemaVersion,
      assets,
    };
  }, bytes.toString("base64"));
}

test("Studio file picker accepts JSON, .xcursus and legacy .spatialdeck", async ({
  page,
}) => {
  await page.goto(studioURL);
  await expect(page.getByLabel("JSON project file")).toHaveAttribute(
    "accept",
    ".json,.xcursus,.spatialdeck,application/json,application/zip",
  );
  await expect(page.getByRole("button", { name: "Open" })).toBeVisible();
});

test("a legacy .spatialdeck opens in Studio, saves as .xcursus and reopens identical", async ({
  page,
  browser,
}, info) => {
  await page.goto(studioURL);
  await page.getByLabel("JSON project file").setInputFiles(legacy);
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(3);
  await expect(page.locator(".warning")).toContainText(
    "Imported a legacy .spatialdeck archive",
  );
  await expect(page.locator(".warning")).toContainText(
    "Save archive writes a .xcursus file",
  );
  const imported = await snapshot(page);
  expect(imported.metadata.author).toBe("SpatialDeck example");
  // The legacy file on disk is only read.
  const original = await readFile(legacy);
  await expect(page.locator(".asset-panel")).not.toContainText("missing");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save archive", exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("Layout_inside_the_scene.xcursus");
  const bytes = await readFile((await saved.path())!);
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(await readFile(legacy)).toEqual(original);

  // A fresh session (no recovery) reopens the saved .xcursus.
  const fresh = await browser.newContext(),
    reopened = await fresh.newPage();
  await reopened.goto(studioURL);
  await reopened.getByLabel("JSON project file").setInputFiles({
    name: saved.suggestedFilename(),
    mimeType: "application/zip",
    buffer: bytes,
  });
  await expect(
    reopened.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(3);
  // No legacy notice for the native format.
  await expect(reopened.locator(".warning")).toHaveCount(0);
  expect(await snapshot(reopened)).toEqual(imported);
  await expect(reopened.locator(".asset-panel")).not.toContainText("missing");
  await expect(reopened.locator(".preview-player .xc-player")).toHaveCount(1);
  // Same document and asset bytes as the legacy archive, read by the library.
  const before = await inspect(reopened, original),
    after = await inspect(reopened, bytes);
  expect(after.document).toEqual(before.document);
  expect(after.assets).toEqual(before.assets);
  expect(Object.keys(after.assets)).toEqual(["skyline"]);
  const assets = after.assets;
  await writeEvidence(`format/${info.project.name}-legacy-roundtrip.json`, {
    suggestedFilename: saved.suggestedFilename(),
    byteLength: bytes.length,
    assets,
  });
  await fresh.close();
});

test("the native example archive opens in Studio and in the vanilla player", async ({
  page,
}) => {
  await page.goto(studioURL);
  await page.getByLabel("JSON project file").setInputFiles(current);
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(3);
  await expect(page.locator(".warning")).toHaveCount(0);
  const studioDoc = await snapshot(page);
  await page.goto("/layout");
  await expect(page.locator(".xc-player")).not.toHaveCount(0);
  for (const file of [current, legacy]) {
    await page.getByLabel("Open local project").setInputFiles(file);
    await expect(
      page.getByRole("status").filter({ hasText: "Project opened" }),
    ).toHaveCount(1);
    const doc = await page.evaluate(() => window.demoDocument);
    expect(doc.scenes).toEqual(studioDoc.scenes);
  }
});
