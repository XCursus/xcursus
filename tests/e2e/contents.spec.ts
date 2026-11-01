import { readFile } from "node:fs/promises";
import { expect, test } from "./runner.js";
import { evidencePath, studioURL, writeEvidence } from "./evidence.js";
import type { Page } from "@playwright/test";
import type { RendererRegistry } from "../../packages/player/src/index.js";
import type { PluginHost } from "../../packages/plugins/src/sdk/index.js";
import type {
  readArchive,
  writeArchive,
} from "../../packages/plugins/src/archive.js";
declare global {
  interface Window {
    contentRegistry: RendererRegistry;
    contentBlobs: Map<string, Blob>;
    contentAPI: {
      RendererRegistry: typeof RendererRegistry;
      PluginHost: typeof PluginHost;
      registerNavigation: typeof import("../../packages/plugins/src/navigation.js").registerNavigation;
      createAssetResolver: typeof import("../../packages/player/src/assets/index.js").createAssetResolver;
      readArchive: typeof readArchive;
      writeArchive: typeof writeArchive;
    };
    hostileMarker?: number;
  }
}
async function gallery(page: Page) {
  await page.goto("/content");
  await expect(page.locator(".xc-player")).toHaveCount(2);
  await expect(
    page
      .locator('.xc-block [role="status"]')
      .filter({ hasText: "Loading local resource" }),
  ).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
async function scene(page: Page, id: string, index = 0) {
  await page.evaluate(
    async ({ id, index }) => {
      await window.demoPlayers[index]!.goTo({ nodeId: id }, { durationMs: 0 });
    },
    { id, index },
  );
}
test("gallery renders real rich content, isolated SVG IDs, MathML and accessible native media offline", async ({
  page,
  context,
}, info) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1") &&
      !r.url().startsWith("blob:") &&
      !r.url().startsWith("data:")
    )
      remote.push(r.url());
  });
  await gallery(page);
  await expect(
    page.locator('#player-1 [data-block-type="markdown"] strong'),
  ).toHaveText("Strong text");
  await expect(
    page.locator('#player-1 [data-block-type="html"] table'),
  ).toHaveCount(1);
  await expect(
    page.locator('#player-1 [data-block-type="latex"] math'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .locator('#player-1 [data-block-type="image"] img')
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const ids = await page
    .locator('[data-block-type="svg"] [id]')
    .evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(new Set(ids).size).toBe(ids.length);
  await context.setOffline(true);
  for (const id of [
    "markdown",
    "html",
    "svg",
    "latex",
    "image",
    "audio",
    "video",
    "link",
    "embed",
    "plugin",
  ])
    await scene(page, id);
  await expect(
    page.locator('#player-1 [data-block-type="plugin"]'),
  ).toContainText("Local plugin");
  await scene(page, "link");
  await page.getByRole("button", { name: "Back to Markdown" }).click();
  await expect
    .poll(() => page.evaluate(() => window.demoPlayers[0]!.getState().sceneId))
    .toBe("markdown");
  expect(remote).toEqual([]);
  await scene(page, "latex");
  await page.locator("#player-1").screenshot({
    path: evidencePath(`content-gallery-${info.project.name}.png`),
  });
});
test("hostile HTML Markdown SVG formulas remain inert at mount and update with no network", async ({
  page,
}) => {
  await gallery(page);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("attack.invalid")) requests.push(r.url());
  });
  const results = await page.evaluate(async () => {
    const d = structuredClone(window.demoDocument);
    d.scenes = d.scenes.slice(0, 1);
    d.paths[0]!.nodes = d.paths[0]!.nodes.slice(0, 1);
    d.paths[0]!.edges = [];
    const html =
      '</script><script>window.hostileMarker=1</script><img src="https://attack.invalid/x" onerror="window.hostileMarker=2"><p style="position:fixed;background:url(https://attack.invalid/css)" onclick="window.hostileMarker=3">SAFE</p><a href="java&#x73;cript:window.hostileMarker=4">bad</a><form action="https://attack.invalid/"><input autofocus></form><iframe src="https://attack.invalid/"></iframe><meta http-equiv="refresh" content="0;url=https://attack.invalid/"><object data="https://attack.invalid/"></object><style>body{display:none}</style>';
    const svg =
      '<svg viewBox="0 0 100 100"><script>window.hostileMarker=5</script><foreignObject><iframe src="https://attack.invalid/"></iframe></foreignObject><animate attributeName="href" values="javascript:window.hostileMarker=6"/><use href="https://attack.invalid/x.svg#x"/><rect id="x" width="80" height="80" fill="url(https://attack.invalid/x)" onload="window.hostileMarker=7"/><use href="#x"/></svg>';
    d.scenes[0]!.blocks = [
      { id: "html", type: "html", data: { source: html } },
      {
        id: "md",
        type: "markdown",
        data: { source: html + "\n[x](jav&#x61;script:alert(1))" },
      },
      { id: "svg", type: "svg", data: { source: svg, alt: "safe shape" } },
      {
        id: "tex",
        type: "latex",
        data: {
          source:
            "\\href{javascript:window.hostileMarker=8}{X}\\htmlStyle{background:url(https://attack.invalid/x)}{X}",
          display: true,
          alt: "hostile formula",
        },
      },
    ];
    const checks = [];
    for (let i = 0; i < 2; i++) {
      if (i) {
        const old = document.querySelector(
          '#player-1 [data-block-type="html"]',
        )!.innerHTML;
        d.scenes[0]!.blocks[0] = {
          id: "html",
          type: "html",
          data: { source: old + html },
        };
      }
      checks.push((await window.demoPlayers[0]!.updateDocument(d)).ok);
      const root = document.querySelector("#player-1")!;
      checks.push(
        !root.querySelector(
          ".xc-block script,.xc-block iframe,.xc-block foreignObject,.xc-block animate,.xc-block form,.xc-block object,.xc-block style,.xc-block img",
        ),
      );
      checks.push(
        ![...root.querySelectorAll(".xc-block *")].some((n) =>
          [...n.attributes].some(
            (a) =>
              a.name.startsWith("on") ||
              (a.name === "href" && !a.value.startsWith("#")),
          ),
        ),
      );
      checks.push(
        !root.querySelector(
          '[data-block-type="html"] [style], [data-block-type="markdown"] [style], [data-block-type="svg"] [style]',
        ),
      );
    }
    const directHost = document.createElement("div");
    document.body.append(directHost);
    const renderer = window.contentRegistry.get("html")!();
    const context: import("../../packages/player/src/content/index.js").ContentContext =
      {
        block: {
          id: "direct",
          type: "html",
          data: { source: "<p>Initial</p>" },
        },
        document: d,
        instanceId: "direct-update",
        active: true,
        mediaEnabled: false,
        mediaMuted: true,
        signal: new AbortController().signal,
        services: {
          navigate: async () => ({ status: "noop" }),
          on: () => () => {},
          emit: () => {},
          report: () => {},
        },
      };
    renderer.mount(directHost, context);
    renderer.update({
      ...context,
      block: { id: "direct", type: "html", data: { source: html } },
    });
    checks.push(
      !directHost.querySelector("script,img,iframe,[style],[onclick]"),
    );
    renderer.destroy();
    directHost.remove();
    return checks;
  });
  expect(results.every(Boolean)).toBe(true);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.hostileMarker)).toBeUndefined();
  expect(requests).toEqual([]);
});
test("LaTeX uses real local font layout, independent macros and bounded errors", async ({
  page,
}) => {
  await gallery(page);
  await expect(page.locator("#player-1 .katex-html .mfrac")).toHaveCount(1);
  const result = await page.evaluate(async () => {
    const d = structuredClone(window.demoDocument),
      s = d.scenes.find((s) => s.id === "latex")!;
    s.blocks = [
      {
        id: "define",
        type: "latex",
        data: {
          source: "\\gdef\\privateMacro{X}\\privateMacro",
          display: true,
          alt: "first",
        },
      },
      {
        id: "use",
        type: "latex",
        data: { source: "\\privateMacro", display: true, alt: "isolated" },
      },
      {
        id: "limit",
        type: "latex",
        data: {
          source: "\\def\\loop{\\loop}\\loop",
          display: true,
          alt: "expansion limit",
        },
      },
    ];
    await window.demoPlayers[0]!.updateDocument(d);
    return [
      ...document.querySelectorAll('#player-1 [data-block-type="latex"]'),
    ].map((n) => n.textContent);
  });
  expect(result[0]).not.toContain("Invalid formula");
  expect(result[1]).toContain("Invalid formula");
  expect(result[2]).toContain("Invalid formula");
});
test("real local audio/video advance, denied play has recovery action, exit stops/pauses and two instances isolate", async ({
  page,
}, info) => {
  await gallery(page);
  await scene(page, "audio");
  await scene(page, "audio", 1);
  const audio = page.locator("#player-1 audio");
  await expect
    .poll(() => audio.evaluate((a) => (a as HTMLAudioElement).readyState))
    .toBeGreaterThanOrEqual(1);
  await page
    .locator("#player-1")
    .getByRole("button", { name: "Enable media" })
    .click();
  await expect
    .poll(() => audio.evaluate((a) => (a as HTMLAudioElement).currentTime))
    .toBeGreaterThan(0.05);
  expect(
    await page
      .locator("#player-2 audio")
      .evaluate((a) => (a as HTMLAudioElement).paused),
  ).toBe(true);
  await scene(page, "video");
  expect(await audio.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(
    true,
  );
  expect(await audio.evaluate((a) => (a as HTMLAudioElement).currentTime)).toBe(
    0,
  );
  const video = page.locator("#player-1 video");
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);
  await page
    .getByRole("button", { name: "Play Moving shapes", exact: true })
    .click();
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.05);
  const dimensions = await video.evaluate((v) => [
    (v as HTMLVideoElement).videoWidth,
    (v as HTMLVideoElement).videoHeight,
  ]);
  expect(dimensions).toEqual([320, 180]);
  await expect(video.locator("track")).toHaveAttribute("kind", "captions");
  await scene(page, "link");
  expect(await video.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(
    true,
  );
  expect(
    await video.evaluate((v) => (v as HTMLVideoElement).currentTime),
  ).toBeGreaterThan(0);
  await scene(page, "video");
  await video.evaluate((v) => {
    (v as HTMLVideoElement).play = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  await page
    .getByRole("button", { name: "Play Moving shapes", exact: true })
    .click();
  await expect(
    page.locator('#player-1 [data-block-type="video"]'),
  ).toContainText("Playback refused");
  await writeEvidence(
    `content-media-${info.project.name}.json`,
    JSON.stringify(
      {
        audioAdvanced: true,
        videoAdvanced: true,
        videoDimensions: dimensions,
        deniedPlay: true,
        exitStopAndPause: true,
        secondInstancePaused: true,
        auditoryVerification: false,
      },
      null,
      2,
    ) + "\n",
  );
});
test("renderer/plugin exceptions are isolated, AbortSignal unsubscribes and every Blob URL is revoked", async ({
  page,
}) => {
  await gallery(page);
  const result = await page.evaluate(async () => {
    const { RendererRegistry, PluginHost, createAssetResolver } =
        window.contentAPI,
      registry = new RendererRegistry(),
      plugins = new PluginHost();
    let mounts = 0,
      destroys = 0,
      cues = 0,
      disposes = 0;
    const events: string[] = [];
    const urls = new Set<string>(),
      create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      revoke(url);
    };
    plugins.register({
      descriptor: {
        id: "org.test.counter",
        version: "1.0.0",
        apiVersion: "1.0.0",
        capabilities: { offline: true, capture: false },
        dataSchemas: { "1.0.0": { schema: {}, validate: () => true } },
      },
      renderer: () => ({
        mount(host, c) {
          mounts++;
          host.textContent = "mounted";
          c.services.on("scenechange", () => cues++);
          c.services.emit("org.test.counter:mounted", null);
        },
        update() {},
        destroy() {
          destroys++;
        },
      }),
      dispose() {
        disposes++;
      },
    });
    plugins.attach(registry);
    registry.register("html", () => ({
      mount() {
        throw new Error("deliberate renderer failure");
      },
      update() {},
      destroy() {
        destroys++;
      },
    }));
    const d = structuredClone(window.demoDocument);
    d.scenes.find((s) => s.id === "html")!.blocks = [];
    d.scenes[0]!.blocks = [
      {
        id: "test",
        type: "plugin",
        data: {
          pluginId: "org.test.counter",
          apiVersion: "1.0.0",
          dataVersion: "1.0.0",
          payload: { source: "unchanged" },
        },
      },
      { id: "bad", type: "html", data: { source: "hello" } },
    ];
    const host = document.createElement("div");
    host.style.height = "400px";
    document.body.append(host);
    const p = window.createDemoPlayer({
      registry,
      assets: createAssetResolver(d.assets, window.contentBlobs),
      onContentEvent: (name) => events.push(name),
    });
    await p.mount(host, d);
    const isolated = host.textContent!.includes("Content error");
    await p.next();
    plugins.destroy();
    const before = cues;
    await p.prev();
    const unsubscribed = cues === before;
    p.destroy();
    p.destroy();
    plugins.destroy();
    host.remove();
    const count = urls.size;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    return {
      mounts,
      destroys,
      cues,
      isolated,
      urls: count,
      unsubscribed,
      disposes,
      events,
    };
  });
  expect(result.mounts).toBe(1);
  expect(result.destroys).toBe(2);
  expect(result.isolated).toBe(true);
  expect(result.urls).toBe(0);
  expect(result.unsubscribed).toBe(true);
  expect(result.disposes).toBe(1);
  expect(result.events).toEqual(["org.test.counter:mounted"]);
  // The actual media renderer owns and releases leases in both gallery instances.
  const leaks = await page.evaluate(async () => {
    const active = new Set<string>(),
      create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => {
      const u = create(b);
      active.add(u);
      return u;
    };
    URL.revokeObjectURL = (u) => {
      active.delete(u);
      revoke(u);
    };
    await Promise.all(
      window.demoPlayers.map((p) => p.updateDocument(window.demoDocument)),
    );
    await new Promise((r) => setTimeout(r, 100));
    window.demoPlayers.forEach((p) => p.destroy());
    await new Promise((r) => setTimeout(r, 100));
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    return active.size;
  });
  expect(leaks).toBe(0);
});
test("gallery archive opens in Studio; every builtin edits with undo/redo and downloads to a new vanilla session", async ({
  page,
  browser,
}, info) => {
  await gallery(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download gallery archive" }).click();
  const source = (await (await download).path())!,
    bytes = await readFile(source);
  await page.goto(studioURL);
  await page.getByLabel("JSON project file").setInputFiles({
    name: "gallery.xcursus",
    mimeType: "application/zip",
    buffer: bytes,
  });
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(11);
  const kinds = [
    "text",
    "markdown",
    "html",
    "svg",
    "latex",
    "image",
    "audio",
    "video",
    "link",
    "embed",
    "plugin",
  ];
  for (const [i, kind] of kinds.entries()) {
    await page
      .getByRole("list", { name: "Scene list" })
      .getByRole("button")
      .nth(i)
      .click();
    const before = await page.evaluate(() =>
      JSON.stringify(window.studio!.store.getSnapshot().document),
    );
    if (kind === "text") {
      await page.getByLabel("Text 1", { exact: true }).fill("Edited text");
      await page.getByLabel("Text 1", { exact: true }).press("Tab");
    } else {
      await page.locator(".block-editor summary").click();
      const field = page.getByLabel(`Data ${kind} 1`, { exact: true }),
        data = JSON.parse(await field.inputValue()) as Record<string, unknown>;
      if ("source" in data) data.source = String(data.source) + " ";
      else if (kind === "plugin") data.payload = { label: "Edited badge" };
      else if ("label" in data) data.label = String(data.label) + " edited";
      else if ("alt" in data) data.alt = String(data.alt) + " edited";
      else data.title = "Edited embed";
      await field.fill(JSON.stringify(data));
      await field.press("Tab");
    }
    const after = await page.evaluate(() =>
      JSON.stringify(window.studio!.store.getSnapshot().document),
    );
    expect(after).not.toBe(before);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(
      await page.evaluate(() =>
        JSON.stringify(window.studio!.store.getSnapshot().document),
      ),
    ).toBe(before);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect(
      await page.evaluate(() =>
        JSON.stringify(window.studio!.store.getSnapshot().document),
      ),
    ).toBe(after);
  }
  const canonical = await page.evaluate(
    () => window.studio!.store.getSnapshot().document,
  );
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-player .xc-player")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Back to the editor", exact: true })
    .click();
  const portable = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save archive", exact: true }).click();
  const saved = await readFile((await (await portable).path())!);
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save JSON", exact: true }).click();
  const json = JSON.parse(
    await readFile((await (await jsonDownload).path())!, "utf8"),
  );
  expect(json).toEqual(canonical);
  const fresh = await browser.newContext(),
    vanilla = await fresh.newPage();
  await gallery(vanilla);
  await vanilla.getByLabel("Open local gallery").setInputFiles({
    name: "edited.xcursus",
    mimeType: "application/zip",
    buffer: saved,
  });
  await expect(
    vanilla.getByRole("status").filter({ hasText: "Project opened" }),
  ).toHaveCount(1);
  expect(await vanilla.evaluate(() => window.demoDocument)).toEqual(canonical);
  await writeEvidence(
    `content-roundtrip-${info.project.name}.json`,
    JSON.stringify(canonical, null, 2) + "\n",
  );
  if (info.project.name === "chromium")
    await page.screenshot({
      path: evidencePath("content-studio.png"),
      fullPage: true,
    });
  await fresh.close();
});
test("missing assets recover manually, Blob revisions survive reload and malformed ZIP never replaces the project", async ({
  page,
}) => {
  await gallery(page);
  const doc = await page.evaluate(() => window.demoDocument);
  await page.goto(studioURL);
  await page.getByLabel("JSON project file").setInputFiles({
    name: "missing.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.locator(".asset-panel")).toContainText("missing");
  const before = await page.evaluate(() =>
    JSON.stringify(window.studio!.store.getSnapshot().document),
  );
  await page.getByLabel("JSON project file").setInputFiles({
    name: "bad.xcursus",
    mimeType: "application/zip",
    buffer: Buffer.from("not a zip"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Could not open the file",
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify(window.studio!.store.getSnapshot().document),
    ),
  ).toBe(before);
  await page
    .getByLabel("Link diagram", { exact: true })
    .setInputFiles("examples/content-gallery/assets/diagram.svg");
  await expect(page.locator(".asset-panel li").first()).toContainText(
    "available",
  );
  await page
    .getByRole("list", { name: "Scene list" })
    .getByRole("button")
    .nth(5)
    .click();
  await expect(
    page.locator('.preview-player [data-block-type="image"] img'),
  ).toHaveCount(1);
  await page.getByLabel("Scene title", { exact: true }).fill("Image recovery");
  await page.getByLabel("Scene title", { exact: true }).press("Tab");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const heads = await window.studio!.repository.heads();
        return heads.some((h) =>
          h.document.scenes.some((s) => s.title === "Image recovery"),
        );
      }),
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "Local recovery available" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Recover revision", exact: true })
    .click();
  await expect(page.locator(".asset-panel li").first()).toContainText(
    "available",
  );
});
test("missing/incompatible plugin payload survives JSON, embed defaults closed and media decode failure remains actionable", async ({
  page,
}) => {
  await gallery(page);
  const result = await page.evaluate(async () => {
    const d = structuredClone(window.demoDocument),
      b = d.scenes.find((s) => s.id === "plugin")!.blocks[0]!;
    if (b.type !== "plugin") throw new Error();
    b.data.pluginId = "org.uninstalled.plugin";
    b.data.dataVersion = "99.0.0";
    b.data.payload = JSON.parse(
      '{"__proto__":{"polluted":true},"source":"</script>"}',
    );
    await window.demoPlayers[0]!.updateDocument(d);
    return {
      text: document.querySelector('#player-1 [data-block-type="plugin"]')!
        .textContent,
      frameCount: document.querySelectorAll("iframe").length,
      polluted: ({} as { polluted?: boolean }).polluted,
      payload: JSON.stringify(b.data.payload),
    };
  });
  expect(result.text).toContain("Data preserved");
  expect(result.frameCount).toBe(0);
  expect(result.polluted).toBeUndefined();
  expect(result.payload).toContain("__proto__");
  await scene(page, "video");
  const errors = await page.evaluate(async () => {
    const d = structuredClone(window.demoDocument),
      bytes = new Uint8Array([
        0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105,
        115, 111, 109, 0, 0, 0, 0,
      ]);
    const asset = d.assets.find((a) => a.id === "motion")!;
    asset.byteLength = bytes.length;
    delete asset.sha256;
    const blobs = new Map(window.contentBlobs);
    blobs.set("motion", new Blob([bytes], { type: "video/mp4" }));
    const host = document.createElement("div");
    host.id = "corrupt-media-test";
    host.style.height = "500px";
    document.body.append(host);
    const p = window.createDemoPlayer({
      registry: window.contentRegistry,
      assets: window.contentAPI.createAssetResolver(d.assets, blobs),
    });
    window.demoPlayers.push(p);
    const error = new Promise<
      import("../../packages/core/src/events/index.js").PlayerEvents["mediaerror"]
    >((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native decoder error not delivered")),
        5000,
      );
      p.on("mediaerror", (e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
    await p.mount(host, d);
    await p.goTo({ nodeId: "video" }, { durationMs: 0 });
    const e = await error;
    return [
      {
        code: e.diagnostic.code,
        sceneId: e.sceneId,
        blockId: e.blockId,
        assetId: e.assetId,
      },
    ];
  });
  expect(errors).toEqual([
    {
      code: "MEDIA_ERROR",
      sceneId: "video",
      blockId: "video-block",
      assetId: "motion",
    },
  ]);
  await expect(
    page.locator('#corrupt-media-test [data-block-type="video"]'),
  ).toContainText("codec is not supported");
  await page.evaluate(() => window.demoPlayers.at(-1)!.destroy());
});
test("authorized embed still needs consent, blocks scripts in opaque sandbox and can revoke consent", async ({
  page,
}) => {
  await gallery(page);
  let requests = 0;
  await page.route("https://frame.example/**", (route) => {
    requests++;
    return route.fulfill({
      contentType: "text/html",
      headers: { "Allow-CSP-From": "*" },
      body: "<p>Frame statico</p><script>parent.hostileMarker=1</script>",
    });
  });
  await page.evaluate(async () => {
    const { RendererRegistry, registerNavigation } = window.contentAPI,
      registry = new RendererRegistry();
    registerNavigation(registry, { allowedOrigins: ["https://frame.example"] });
    const host = document.createElement("div");
    host.id = "embed-test";
    host.style.height = "500px";
    document.body.append(host);
    const d = structuredClone(window.demoDocument);
    d.scenes[0]!.blocks = [
      {
        id: "embed",
        type: "embed",
        data: { url: "https://frame.example/", title: "Authorized frame" },
      },
    ];
    const p = window.createDemoPlayer({ registry });
    await p.mount(host, d);
    window.demoPlayers.push(p);
  });
  expect(requests).toBe(0);
  await page
    .getByRole("button", {
      name: "Allow embed: Authorized frame",
      exact: true,
    })
    .click();
  const frame = page.locator("#embed-test iframe");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("csp", /script-src 'none'/);
  expect(await page.evaluate(() => window.hostileMarker)).toBeUndefined();
  await page
    .getByRole("button", { name: "Remove embed consent", exact: true })
    .click();
  await expect(frame).toHaveCount(0);
});
test("Blob recovery is atomic with revisions, retains old resources and collects only unreferenced data", async ({
  page,
}, info) => {
  await gallery(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download gallery archive" }).click();
  const bytes = await readFile((await (await download).path())!);
  await page.goto(studioURL);
  await page.getByLabel("JSON project file").setInputFiles({
    name: "gallery.xcursus",
    mimeType: "application/zip",
    buffer: bytes,
  });
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(11);
  await page
    .getByLabel("Project title", { exact: true })
    .fill("Recovery Blobs");
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.studio!.repository.heads()).some(
          (h) => h.document.metadata.title === "Recovery Blobs",
        ),
      ),
    )
    .toBe(true);
  const evidence = await page.evaluate(async () => {
    const repo = window.studio!.repository,
      head = (await repo.heads())[0]!,
      blobs = await repo.blobs(head),
      doc = structuredClone(head.document);
    doc.assets = doc.assets.filter((a) => a.id !== "captions");
    const video = doc.scenes.find((s) => s.id === "video")!.blocks[0]!;
    if (video.type === "video") delete video.data.captionsAssetId;
    let latest = await repo.save(doc, head.revision, blobs);
    const retained = (await repo.blobs(head)).size;
    for (let i = 0; i < 10; i++)
      latest = await repo.save(doc, latest.revision, blobs);
    const count = await new Promise<number>((resolve, reject) => {
      // The current version: Studio 0.4.1 upgraded the database to v3.
      const open = indexedDB.open("spatialdeck-studio");
      open.onsuccess = () => {
        const db = open.result,
          tx = db.transaction("assets", "readonly"),
          req = tx.objectStore("assets").count();
        tx.oncomplete = () => {
          resolve(req.result);
          db.close();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === "assets")
        throw new DOMException("quota", "QuotaExceededError");
      return put.apply(this, args);
    };
    // Unchanged resources are not rewritten since 0.4.1: inject the quota
    // failure on the bytes of a new resource in the same transaction.
    const extra = new Blob(["WEBVTT\n\nquota\n"], { type: "text/vtt" });
    const withExtra = structuredClone(doc);
    withExtra.assets.push({
      id: "quota-extra",
      path: "assets/quota-extra/quota.vtt",
      mime: "text/vtt",
      byteLength: extra.size,
    });
    let quota = false;
    try {
      await repo.save(
        withExtra,
        latest.revision,
        new Map([...blobs, ["quota-extra", extra]]),
      );
    } catch {
      quota = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    return {
      initial: blobs.size,
      retained,
      afterGC: count,
      revisions: (await repo.revisions(doc.id)).length,
      quota,
      rollback: (await repo.heads())[0]!.revision === latest.revision,
    };
  });
  expect(evidence).toEqual({
    initial: 4,
    retained: 4,
    afterGC: 3,
    revisions: 10,
    quota: true,
    rollback: true,
  });
  await writeEvidence(
    `content-storage-${info.project.name}.json`,
    JSON.stringify(evidence, null, 2) + "\n",
  );
});
