import { createReadStream } from "node:fs";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./runner.js";
import { evidencePath, writeEvidence } from "./evidence.js";
declare global {
  interface Window {
    studioShell?: ServiceWorkerRegistration;
  }
}
// 0.6 offline shell of the production Studio: versioned worker, offline
// reload with the IndexedDB project, explicit non-destructive update.
const shellCaches = (page: Page) =>
  page.evaluate(async () => (await caches.keys()).sort());
async function controlled(page: Page) {
  await page.waitForFunction(
    async () => !!(await navigator.serviceWorker.ready).active,
  );
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller)))
    await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};
/**
 * A copy of the production Studio on its own server, read from disk on every
 * request and never cached by HTTP: replacing a file is a new deployment.
 */
async function deployment(name: string) {
  const dir = evidencePath(`pwa/${name}`);
  await rm(dir, { recursive: true, force: true });
  await cp(
    fileURLToPath(new URL("../../apps/studio/dist", import.meta.url)),
    dir,
    { recursive: true },
  );
  const server = createServer(async (request, response) => {
    const path = resolve(dir, "." + new URL(request.url!, "http://x").pathname);
    try {
      const file =
        path === dir || path === dir + "/" ? join(dir, "index.html") : path;
      if (!file.startsWith(dir) || !(await stat(file)).isFile()) throw Error();
      response.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    /** The origin is unreachable: the network is really off for the shell. */
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    start: () =>
      new Promise<void>((done) => server.listen(port, "127.0.0.1", done)),
    /** Same files, new worker: the cache name changes like after a rebuild. */
    async release() {
      const sw = join(dir, "sw.js");
      await writeFile(
        sw,
        (await readFile(sw, "utf8")).replace(
          /const CACHE = PREFIX \+ "([0-9a-f]+)";/,
          'const CACHE = PREFIX + "$1-next";',
        ),
      );
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  };
}

test("Studio shell: offline reload with the IndexedDB project, explicit update keeps data and removes only its own old cache", async ({
  page,
  browserName,
}) => {
  const site = await deployment(browserName);
  try {
    await page.goto(`${site.url}/?studio-debug`);
    await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
    await controlled(page);
    const first = await shellCaches(page);
    expect(first.filter((k) => k.startsWith("xcursus-studio-"))).toHaveLength(
      1,
    );
    // Work that exists only in IndexedDB (autosave), a cache of another app and
    // one left by a release published under the former name.
    await page.getByRole("button", { name: "Create the first scene" }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await window.studio!.repository.heads()).length,
          ),
        { timeout: 10000 },
      )
      .toBe(1);
    // The first installation is not an update: no notice (WebKit regression).
    await expect(page.locator("#shell-update")).toHaveCount(0);
    await page.evaluate(async () => {
      const cache = await caches.open("another-app");
      await cache.put("/another-app/data", new Response("keep me"));
      const legacy = await caches.open("spatialdeck-studio-0123456789abcdef");
      await legacy.put("/legacy/data", new Response("stale shell"));
    });
    // Offline: the server is down, the shell comes from the cache and the
    // project from IndexedDB.
    await site.stop();
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
    await expect(
      page.getByRole("dialog", { name: "Local recovery available" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Recover revision" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.studio!.store.getSnapshot().document.scenes.length,
        ),
      )
      .toBe(1);
    await site.start();
    // A new deployment waits for the user's choice.
    await site.release();
    await page.evaluate(() => window.studioShell!.update());
    const notice = page.locator("#shell-update");
    await expect(notice).toBeVisible({ timeout: 15000 });
    expect(
      (await shellCaches(page)).filter((k) => k.startsWith("xcursus-studio-")),
    ).toHaveLength(2);
    // Nothing changes until the user asks: still the first version.
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.studioShell!.waiting?.state)).toBe(
      "installed",
    );
    await Promise.all([
      page.waitForEvent("load"),
      notice.getByRole("button", { name: "Update and reload" }).click(),
    ]);
    await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
    const after = await shellCaches(page);
    const own = after.filter((k) => k.startsWith("xcursus-studio-"));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/-next$/);
    expect(after).toContain("another-app");
    expect(after.filter((k) => k.startsWith("spatialdeck-studio-"))).toEqual(
      [],
    );
    // Data survive the update.
    const heads = await page.evaluate(
      async () => (await window.studio!.repository.heads()).length,
    );
    expect(heads).toBe(1);
    await writeEvidence(`pwa/${browserName}-caches.json`, { first, after });
  } finally {
    await site.close();
  }
});

test("with the shell offline, the export panel still writes the standalone HTML", async ({
  page,
  browserName,
}) => {
  const site = await deployment(`${browserName}-export`);
  try {
    await page.goto(`${site.url}/?studio-debug`);
    await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
    await controlled(page);
    // The export kit is part of the precached shell, not fetched later.
    expect(
      await page.evaluate(async () => {
        for (const key of await caches.keys())
          if (
            key.startsWith("xcursus-studio-") &&
            (await (await caches.open(key)).match("export-kit.json"))
          )
            return true;
        return false;
      }),
    ).toBe(true);
    await site.stop();
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
    await page
      .getByLabel("JSON project file")
      .setInputFiles("examples/layout-canvas/layout-canvas.xcursus");
    const exportButton = page.getByRole("button", {
      name: "Export",
      exact: true,
    });
    await expect(exportButton).toBeEnabled();
    await exportButton.click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("dialog", { name: "Export" })
      .getByRole("button", { name: "Download HTML" })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.html$/);
    const html = await readFile((await file.path())!, "utf8");
    expect(html).toContain('<meta name="generator" content="XCursus Studio ');
    expect(html).toContain("connect-src 'none'");
  } finally {
    await site.close();
  }
});

test("the player playground does not use the Studio worker", async ({
  page,
}) => {
  await page.goto("/core");
  await expect(page.locator(".xc-player")).toHaveCount(2);
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistrations()).length,
    ),
  ).toBe(0);
});
