import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import {
  frameToScene,
  planCapture,
  projectScenePoint,
  resolveSceneCamera,
  sampleCapture,
  validateDocument,
} from "../../packages/core/src/index.js";
import type {
  CameraPose,
  Point,
  ProjectDocument,
} from "../../packages/core/src/index.js";
import { test, expect } from "./runner.js";
import { evidencePath, writeEvidence } from "./evidence.js";

// 0.6 distribution: everything here runs the packages installed from their
// `pnpm pack` tarballs in test-results/packages/consumer (scripts/check-packages.mjs),
// never the workspace sources.
const run = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /\/$/,
  "",
);
const consumer = join(root, "test-results/packages/consumer");
const cli = join(consumer, "node_modules/.bin/xcursus");
const fixtureDir = join(root, "examples/distribution-static");
const project = join(fixtureDir, "project.json");
declare global {
  interface Window {
    consumer?: { players?: unknown[]; results?: boolean[]; ok?: boolean };
    cspViolations: string[];
    pwned?: number;
  }
}
async function xcursus(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await run(cli, args, {
      cwd: root,
      env: { ...process.env, ...env },
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}
const doc = async (path = project): Promise<ProjectDocument> => {
  const r = validateDocument(await readFile(path, "utf8"));
  if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
  return r.value;
};
/** Fresh evidence directory per browser project. */
async function outDir(name: string, browser: string) {
  const dir = evidencePath(`distribution/${browser}/${name}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".xcursus": "application/zip",
  ".txt": "text/plain",
};
/** Minimal static server for built outputs; only files inside `dir`. */
async function serve(dir: string) {
  const server = createServer(async (request, response) => {
    const path = resolve(
      dir,
      "." + decodeURIComponent(new URL(request.url!, "http://x").pathname),
    );
    if (!path.startsWith(dir)) return void response.writeHead(403).end();
    try {
      const file = (await stat(path)).isDirectory()
        ? join(path, "index.html")
        : path;
      await stat(file);
      response.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    // Keep-alive connections of the browser would otherwise hold close() open.
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  };
}
/**
 * Network off for a file:// page: offline emulation where the runner supports
 * it with file URLs (Chromium, Firefox); WebKit of the macOS 14 runner fails to
 * load file:// offline, so there every http(s)/ws(s) request is aborted and
 * counted like everywhere else.
 */
async function offline(page: Page, browserName: string) {
  if (browserName !== "webkit") await page.context().setOffline(true);
}
/** Records CSP violations and every network request of an offline page. */
async function guard(page: Page) {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.context().route(/^(https?|wss?):/, (route) => route.abort());
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return () => requests.filter((u) => /^(https?|wss?):/.test(u));
}
/** Frame corners of canvas blocks, in viewport pixels from the stage centre. */
async function landmarks(
  page: Page,
  d: ProjectDocument,
  sceneId: string,
  camera: CameraPose,
) {
  const scene = d.scenes.find((s) => s.id === sceneId)!;
  const expected = scene.blocks.map((b) =>
    (
      [
        [0, 0],
        [b.frame!.width, 0],
        [b.frame!.width, b.frame!.height],
        [0, b.frame!.height],
      ] as Point[]
    ).map((p) => {
      const r = projectScenePoint(
        d,
        sceneId,
        camera,
        frameToScene(b.frame!, p),
      );
      if (!r.ok) throw Error();
      return [
        r.value[0] - d.settings.viewport.width / 2,
        r.value[1] - d.settings.viewport.height / 2,
      ];
    }),
  );
  const actual = await page.evaluate(
    ({ sceneId, blocks }) => {
      const viewport = document.querySelector<HTMLElement>(".xc-viewport")!;
      const rect = viewport.getBoundingClientRect(),
        fit = rect.width / parseFloat(viewport.style.width);
      return blocks.map(({ id, points }) => {
        const host = document.querySelector<HTMLElement>(
          `.xc-scene[data-scene-id="${sceneId}"] [data-block-id="${id}"]`,
        )!;
        return points.map(([x, y]) => {
          const marker = document.createElement("i");
          marker.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
          host.append(marker);
          const b = marker.getBoundingClientRect();
          marker.remove();
          return [
            (b.x - rect.x - rect.width / 2) / fit,
            (b.y - rect.y - rect.height / 2) / fit,
          ];
        });
      });
    },
    {
      sceneId,
      blocks: scene.blocks.map((b) => ({
        id: b.id,
        points: [
          [0, 0],
          [b.frame!.width, 0],
          [b.frame!.width, b.frame!.height],
          [0, b.frame!.height],
        ],
      })),
    },
  );
  let max = 0;
  actual.forEach((points, i) =>
    points.forEach((p, j) =>
      p.forEach(
        (n, k) => (max = Math.max(max, Math.abs(n - expected[i]![j]![k]!))),
      ),
    ),
  );
  return max;
}

test.beforeAll(async () => {
  await stat(cli).catch(() => {
    throw new Error(
      "Packaged CLI missing: run node scripts/check-packages.mjs (part of pnpm test:e2e)",
    );
  });
});

test("minimal ESM consumer built from the tarballs: two players, destroy, no React or editor", async ({
  page,
}) => {
  const server = await serve(join(consumer, "dist"));
  try {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${server.url}/minimal.html`);
    await page.waitForFunction(() => window.consumer?.results?.length === 2);
    expect(await page.evaluate(() => window.consumer!.results)).toEqual([
      true,
      true,
    ]);
    await expect(page.locator(".xc-player")).toHaveCount(2);
    await page.locator("#a").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#a .xc-live")).not.toHaveText("");
    await page.getByRole("button", { name: "Destroy" }).click();
    await expect(page.locator(".xc-player")).toHaveCount(0);
    expect(errors).toEqual([]);
    // Only the minimal entry: no lazy rich/media chunk, nothing from React or the editor.
    expect(requests.filter((u) => /rich-|media-|react|editor/.test(u))).toEqual(
      [],
    );
  } finally {
    await server.close();
  }
});

test("realistic consumer: rich and media renderers load on demand with local woff2 fonts", async ({
  page,
}) => {
  const server = await serve(join(consumer, "dist"));
  try {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto(`${server.url}/realistic.html`);
    await page.waitForFunction(() => window.consumer?.ok === true);
    await expect(page.locator('[data-block-type="latex"] .katex')).toHaveCount(
      1,
      { timeout: 15000 },
    );
    await expect(
      page
        .locator(
          '[data-block-type="markdown"] strong, [data-block-type="markdown"] em',
        )
        .first(),
    ).toBeAttached();
    await expect(page.locator('[data-block-type="image"] img')).toHaveCount(1);
    expect(requests.some((u) => /\/assets\/rich-[^/]+\.js$/.test(u))).toBe(
      true,
    );
    expect(requests.some((u) => /\/assets\/media-[^/]+\.js$/.test(u))).toBe(
      true,
    );
    expect(requests.filter((u) => /\.(woff|ttf)$/.test(u))).toEqual([]);
  } finally {
    await server.close();
  }
});

test("standalone HTML from the packaged CLI opens from file:// offline, under its CSP, with canvas, theme font and inert payload", async ({
  page,
  browserName,
}) => {
  const dir = await outDir("html", browserName);
  const out = join(dir, "fixture.html");
  const r = await xcursus(["export", "html", project, "--out", out]);
  expect(r.code, r.stderr).toBe(0);
  const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"));
  expect(manifest).toMatchObject({
    format: "html",
    status: "complete",
    privateNotes: "excluded",
  });
  expect(manifest.verification).toMatchObject({
    jsonBlocksParse: true,
    cspHashesMatchInlineCode: true,
    privateNotesAbsent: true,
  });
  expect(
    manifest.resources.filter((x: { kind: string }) => x.kind === "font")
      .length,
  ).toBeGreaterThan(0);
  expect(manifest.licenses.map((l: { name: string }) => l.name)).toEqual(
    expect.arrayContaining([
      "katex",
      "dompurify",
      "@fontsource/atkinson-hyperlegible",
    ]),
  );
  const html = await readFile(out, "utf8");
  expect(html).not.toContain("PRIVATE-NOTE");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(
    html,
  )![1]!;
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  expect(csp).not.toMatch(/unsafe-eval|unsafe-inline/);
  expect(html).toContain("<noscript>");
  expect(html).toContain('id="xcursus-notices"');
  await offline(page, browserName);
  const network = await guard(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(pathToFileURL(out).href);
  await page.waitForFunction(
    () => document.documentElement.dataset.xcursus === "ready",
  );
  await expect(page.locator('[data-block-id="formula"] .katex')).toHaveCount(1);
  await expect(page.locator('[data-block-id="picture"] img')).toHaveJSProperty(
    "complete",
    true,
  );
  expect(
    await page
      .locator('[data-block-id="picture"] img')
      .evaluate((i: HTMLImageElement) => i.naturalWidth),
  ).toBeGreaterThan(0);
  await expect(page.locator('[data-block-id="payload"]')).toHaveText(
    "Literal text: </script><script>window.pwned=1</script> stays text.",
  );
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      document.fonts.check('28px "XCursus Atkinson Hyperlegible"'),
    ),
  ).toBe(true);
  expect(
    await page
      .locator('[data-block-id="headline"]')
      .evaluate((e) => getComputedStyle(e).fontFamily),
  ).toContain("XCursus Atkinson Hyperlegible");
  // Canvas frames: the same core projection as the player, within 1 px.
  const d = await doc();
  const camera = resolveSceneCamera(d, "cover");
  if (!camera.ok) throw Error();
  expect(await landmarks(page, d, "cover", camera.value)).toBeLessThanOrEqual(
    1,
  );
  // Clipping on the content wrapper of a canvas scene.
  expect(
    await page
      .locator('.xc-scene[data-scene-id="cover"] .xc-content')
      .evaluate((e) => getComputedStyle(e).overflow),
  ).toBe("hidden");
  // Navigation with the keyboard inside the presentation.
  await page.locator("#xcursus-stage").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".xc-live")).toHaveText("Flow scene with Markdown");
  await expect(
    page.locator('.xc-scene[data-scene-id="context"]'),
  ).toHaveAttribute("data-active", "true");
  // Without a keyboard: on-screen buttons and a touch swipe (1.0).
  const nav = page.getByRole("navigation", { name: "Presentation navigation" });
  await nav.getByRole("button", { name: "Previous" }).click();
  await expect(page.locator(".xc-live")).not.toHaveText(
    "Flow scene with Markdown",
  );
  await expect(nav.getByRole("button", { name: "Previous" })).toBeDisabled();
  await nav.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".xc-live")).toHaveText("Flow scene with Markdown");
  const swipe = async (from: number, to: number) => {
    for (const [type, x] of [
      ["pointerdown", from],
      ["pointerup", to],
    ] as const)
      await page.locator("#xcursus-stage").dispatchEvent(type, {
        pointerType: "touch",
        pointerId: 7,
        isPrimary: true,
        clientX: x,
        clientY: 400,
        bubbles: true,
      });
  };
  await swipe(900, 400);
  await expect(
    page.locator('.xc-scene[data-scene-id="detail"]'),
  ).toHaveAttribute("data-active", "true");
  // The fixture path loops from the last scene back to the first: Next stays enabled.
  await expect(nav.getByRole("button", { name: "Next" })).toBeEnabled();
  await swipe(400, 900);
  await expect(
    page.locator('.xc-scene[data-scene-id="context"]'),
  ).toHaveAttribute("data-active", "true");
  const targets = await nav.getByRole("button").evaluateAll((buttons) =>
    buttons.map((b) => {
      const box = b.getBoundingClientRect();
      return Math.min(box.width, box.height);
    }),
  );
  expect(Math.min(...targets)).toBeGreaterThanOrEqual(44);
  expect(await page.content()).not.toContain("PRIVATE-NOTE");
  expect(network()).toEqual([]);
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  await page.screenshot({ path: join(dir, "html-context.png") });
});

test("strict export refuses iframe, plugin and remote font; --allow-partial writes placeholders and a truthful partial manifest", async ({
  page,
  browserName,
}) => {
  const dir = await outDir("partial", browserName);
  await mkdir(join(dir, "assets"));
  await copyFile(
    join(fixtureDir, "assets/orbit.svg"),
    join(dir, "assets/orbit.svg"),
  );
  const d = JSON.parse(await readFile(project, "utf8"));
  d.scenes[1].blocks.push(
    {
      id: "web",
      type: "embed",
      data: { url: "https://example.org/", title: "Remote page" },
    },
    {
      id: "badge",
      type: "plugin",
      data: {
        pluginId: "org.xcursus.badge",
        apiVersion: "1.0.0",
        dataVersion: "1.0.0",
        payload: { label: "Badge" },
      },
    },
    {
      id: "font",
      type: "html",
      data: {
        source:
          '<link rel="stylesheet" href="https://fonts.example/f.css"><p>Remote font</p>',
      },
    },
  );
  const input = join(dir, "project.json");
  await writeFile(input, JSON.stringify(d));
  const out = join(dir, "partial.html");
  const strict = await xcursus(["export", "html", input, "--out", out]);
  expect(strict.code).toBe(1);
  for (const code of ["EMBED_REMOTE", "PLUGIN_UNAVAILABLE", "REMOTE_RESOURCE"])
    expect(strict.stderr).toContain(code);
  await expect(stat(out)).rejects.toThrow();
  const partial = await xcursus([
    "export",
    "html",
    input,
    "--out",
    out,
    "--allow-partial",
  ]);
  expect(partial.code, partial.stderr).toBe(0);
  const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"));
  expect(manifest.status).toBe("partial");
  expect(manifest.warnings.map((w: { code: string }) => w.code)).toEqual(
    expect.arrayContaining([
      "EMBED_REMOTE",
      "PLUGIN_UNAVAILABLE",
      "REMOTE_RESOURCE",
    ]),
  );
  // Every block the output changes is listed, the kept remote-font block too;
  // in a written output the findings are warnings.
  expect(
    manifest.unsupported.map((u: { blockId: string }) => u.blockId).sort(),
  ).toEqual(["badge", "font", "web"]);
  expect(
    manifest.unsupported.find((u: { blockId: string }) => u.blockId === "font")
      .reason,
  ).toBe("remote resource removed by the sanitizer");
  expect(
    new Set(manifest.warnings.map((w: { severity: string }) => w.severity)),
  ).toEqual(new Set(["warning"]));
  await offline(page, browserName);
  const network = await guard(page);
  await page.goto(pathToFileURL(out).href);
  await page.waitForFunction(
    () => document.documentElement.dataset.xcursus === "ready",
  );
  await expect(
    page.locator('[data-block-id="web"] .xc-export-placeholder'),
  ).toHaveText("Content unavailable (embed)");
  await expect(
    page.locator('[data-block-id="badge"] .xc-export-placeholder'),
  ).toHaveText("Content unavailable (plugin)");
  await expect(page.locator('[data-block-id="font"]')).toHaveText(
    "Remote font",
  );
  expect(await page.locator("link, iframe").count()).toBe(0);
  expect(network()).toEqual([]);
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
});

test("PDF of pasted HTML with style and on* attributes: blocked by the CSP, counted as a warning, never fatal", async ({
  browserName,
}) => {
  // Chromium reports the attributes while the sanitizer parses the source it
  // then strips; before the fix the capture failed with exit 3.
  const dir = await outDir("pasted-html", browserName);
  await mkdir(join(dir, "assets"));
  await copyFile(
    join(fixtureDir, "assets/orbit.svg"),
    join(dir, "assets/orbit.svg"),
  );
  const d = JSON.parse(await readFile(project, "utf8"));
  d.scenes[1].blocks.push({
    id: "pasted",
    type: "html",
    data: {
      source:
        '<p style="color:#b91c1c" onclick="window.pwned=1">Pasted <span style="font-weight:bold">paragraph</span></p>',
    },
  });
  const input = join(dir, "project.json");
  await writeFile(input, JSON.stringify(d));
  const out = join(dir, "pasted.pdf");
  const r = await xcursus([
    "export",
    "pdf",
    input,
    "--itinerary",
    join(fixtureDir, "itinerary.json"),
    "--out",
    out,
  ]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stderr).toContain("CSP_ATTRIBUTE_BLOCKED");
  const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"));
  expect(manifest.status).toBe("complete");
  expect(manifest.verification.pageCount).toBe(3);
  expect(
    manifest.warnings.find(
      (w: { code: string }) => w.code === "CSP_ATTRIBUTE_BLOCKED",
    ),
  ).toMatchObject({ severity: "warning" });
});

test("PDF of a flow scene taller than itself: the cut is reported as CONTENT_OVERFLOW", async ({
  browserName,
}) => {
  const dir = await outDir("overflow", browserName);
  await mkdir(join(dir, "assets"));
  await copyFile(
    join(fixtureDir, "assets/orbit.svg"),
    join(dir, "assets/orbit.svg"),
  );
  const d = JSON.parse(await readFile(project, "utf8"));
  d.scenes[1].blocks.push({
    id: "long",
    type: "text",
    data: { text: "A line of text that does not fit.\n".repeat(40) },
  });
  const input = join(dir, "project.json");
  await writeFile(input, JSON.stringify(d));
  const out = join(dir, "overflow.pdf");
  const r = await xcursus([
    "export",
    "pdf",
    input,
    "--itinerary",
    join(fixtureDir, "itinerary.json"),
    "--out",
    out,
  ]);
  expect(r.code, r.stderr).toBe(0);
  const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"));
  const overflow = manifest.warnings.filter(
    (w: { code: string }) => w.code === "CONTENT_OVERFLOW",
  );
  // Only the flow scene that was made too long; the other two visits fit.
  expect(overflow).toHaveLength(1);
  expect(overflow[0]).toMatchObject({
    severity: "warning",
    pointer: "/scenes/1",
  });
});

test("video with an animated GIF: captured as its first frame, the same frames on every run", async ({
  browserName,
}) => {
  test.setTimeout(240000);
  const dir = await outDir("animated", browserName);
  await mkdir(join(dir, "assets"));
  await copyFile(
    join(fixtureDir, "assets/orbit.svg"),
    join(dir, "assets/orbit.svg"),
  );
  // Red and blue 2×2 frames of 100 ms, looping: on the wall clock each run
  // would catch other frames.
  const bytes = Buffer.from(
    "R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7",
    "base64",
  );
  await writeFile(join(dir, "assets/pulse.gif"), bytes);
  const d = JSON.parse(await readFile(project, "utf8"));
  d.assets.push({
    id: "pulse",
    path: "assets/pulse.gif",
    mime: "image/gif",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  d.scenes[1].blocks.push({
    id: "pulse",
    type: "image",
    data: {
      assetId: "pulse",
      alt: "Square turning red and blue",
      fit: "contain",
    },
  });
  const input = join(dir, "project.json");
  await writeFile(input, JSON.stringify(d));
  const runs: string[][] = [];
  for (const run of ["first", "second"]) {
    const frames = join(dir, `frames-${run}`);
    await mkdir(frames);
    const out = join(dir, `${run}.webm`);
    const r = await xcursus([
      "export",
      "video",
      input,
      "--itinerary",
      join(fixtureDir, "itinerary.json"),
      "--fps",
      "10",
      "--out",
      out,
      "--frames",
      frames,
    ]);
    expect(r.code, r.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"));
    expect(
      manifest.warnings.find(
        (w: { code: string }) => w.code === "ANIMATION_FROZEN",
      ),
    ).toMatchObject({ severity: "warning", pointer: "/assets/1" });
    const names = (await readdir(frames)).sort();
    runs.push(
      await Promise.all(
        names.map(async (name) =>
          createHash("sha256")
            .update(await readFile(join(frames, name)))
            .digest("hex"),
        ),
      ),
    );
  }
  expect(runs[0]!.length).toBe(48);
  expect(runs[1]).toEqual(runs[0]);
});

test("static build from the packaged CLI serves runtime, JSON and verified assets over HTTP without notes", async ({
  page,
  browserName,
}) => {
  const dir = await outDir("build", browserName);
  const out = join(dir, "site");
  const r = await xcursus(["build", project, "--out", out]);
  expect(r.code, r.stderr).toBe(0);
  const files = await readdir(out);
  expect(files).toEqual(
    expect.arrayContaining([
      "index.html",
      "project.json",
      "xcursus-runtime.js",
      "THIRD_PARTY_NOTICES.txt",
      "export-manifest.json",
      "player.css",
      "fonts.css",
      "katex.css",
      "assets",
      "fonts",
    ]),
  );
  expect(await readFile(join(out, "project.json"), "utf8")).not.toContain(
    "PRIVATE-NOTE",
  );
  // A second build without --overwrite is refused; with it, the owned directory is replaced.
  expect((await xcursus(["build", project, "--out", out])).code).toBe(3);
  expect(
    (await xcursus(["build", project, "--out", out, "--overwrite"])).code,
  ).toBe(0);
  const server = await serve(out);
  try {
    const requests: string[] = [];
    page.on("request", (q) => requests.push(q.url()));
    await page.addInitScript(() => {
      window.cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        window.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    });
    await page.goto(`${server.url}/index.html`);
    await page.waitForFunction(
      () => document.documentElement.dataset.xcursus === "ready",
    );
    await expect(page.locator('[data-block-id="picture"] img')).toHaveCount(1);
    await expect(page.locator('[data-block-id="formula"] .katex')).toHaveCount(
      1,
    );
    expect(
      requests.every(
        (u) => u.startsWith(server.url) || /^(blob|data):/.test(u),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  } finally {
    await server.close();
  }
});

/** Page rasteriser of the PDF inspection tools installed on the test machine. */
async function pdfTool(name: "pdftotext" | "pdftopng" | "pdftoppm") {
  try {
    await run(name, ["-v"]);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ENOENT";
  }
}
test("PDF: three visits give three pages in order, a repeated visit a distinct page, vector text without notes", async ({
  browserName,
}) => {
  const dir = await outDir("pdf", browserName);
  const results: Record<string, unknown> = {};
  // Words of each visit's scene; the first page is frontal, its headline is always vector text.
  const cover = ["One player, every output"],
    context = ["Markdown", "sanitized", "pipeline", "file://"],
    detail = ["Frames stay 2D", "Rotated child scene", "Back to the cover"];
  for (const [name, visits] of [
    ["itinerary", [cover, context, detail]],
    ["itinerary-repeat", [cover, context, detail, cover]],
  ] as const) {
    const out = join(dir, `${name}.pdf`);
    const r = await xcursus([
      "export",
      "pdf",
      project,
      "--itinerary",
      join(fixtureDir, `${name}.json`),
      "--out",
      out,
    ]);
    expect(r.code, r.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"));
    expect(manifest.verification).toMatchObject({
      singlePagePrints: true,
      pageCount: visits.length,
      expectedPages: visits.length,
      allPagesViewportSize: true,
      pageSizePt: [960, 540],
    });
    expect(manifest.warnings.map((w: { code: string }) => w.code)).toContain(
      "LINK_STATIC",
    );
    expect(
      manifest.itinerary.visits.map((v: { nodeId: string }) => v.nodeId),
    ).toEqual(
      name === "itinerary" ? ["n1", "n2", "n3"] : ["n1", "n2", "n3", "n1"],
    );
    // Text per page through an independent PDF reader. Chromium keeps text
    // vector on a frontal scene and may rasterise perspective layers, so a
    // page can have no extractable text; when it has some, it is its visit's.
    expect(
      await pdfTool("pdftotext"),
      "pdftotext (poppler or xpdf) is required to inspect PDF pages",
    ).toBe(true);
    const { stdout } = await run("pdftotext", ["-layout", out, "-"]);
    const pages = stdout.split("\f").slice(0, -1);
    expect(pages).toHaveLength(visits.length);
    pages.forEach((text, i) => {
      const flat = text.replace(/\s+/g, " ");
      if (flat.trim())
        expect(
          visits[i]!.some((w) => flat.includes(w)),
          `page ${i + 1}: ${flat}`,
        ).toBe(true);
    });
    expect(pages[0]!.replace(/\s+/g, " ")).toContain(cover[0]);
    expect(stdout).not.toContain("PRIVATE-NOTE");
    // Rasterised pages (xpdf pdftopng or poppler pdftoppm -png), kept as evidence:
    // distinct visits give distinct pages, the repeated visit the same page.
    const prefix = join(dir, `${name}-page`);
    if (await pdfTool("pdftopng"))
      await run("pdftopng", ["-r", "48", out, prefix]);
    else await run("pdftoppm", ["-png", "-r", "48", out, prefix]);
    const images = (await readdir(dir))
      .filter((f) => f.startsWith(`${name}-page`) && f.endsWith(".png"))
      .sort()
      .map((f) => join(dir, f));
    expect(images).toHaveLength(visits.length);
    for (let i = 1; i < 3; i++)
      expect(await difference(images[i - 1]!, images[i]!)).toBeGreaterThan(5);
    if (visits.length === 4)
      expect(await difference(images[0]!, images[3]!)).toBeLessThan(0.5);
    results[name] = {
      pages: pages.length,
      textPages: pages.filter((p) => p.trim()).length,
      verification: manifest.verification,
    };
  }
  await writeEvidence(`distribution/${browserName}/pdf/summary.json`, results);
});

/** Mean absolute channel difference between two same-size PNG files, decoded by FFmpeg. */
async function difference(a: string, b: string) {
  const { stdout } = await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    a,
    "-i",
    b,
    "-lavfi",
    "[0:v][1:v]blend=all_mode=difference,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
    "-f",
    "null",
    "-",
  ]);
  return Number(/YAVG=([\d.]+)/.exec(stdout)?.[1] ?? NaN);
}
test("video: WebM frame count and duration within one frame, poses equal to the sampler, frames inspected and reproducible", async ({
  browserName,
}) => {
  test.setTimeout(240000);
  const dir = await outDir("video", browserName);
  const d = await doc();
  const itinerary = JSON.parse(
    await readFile(join(fixtureDir, "itinerary.json"), "utf8"),
  );
  const plan = planCapture(d, itinerary, { reducedMotion: false });
  if (!plan.ok) throw Error();
  const runs = [];
  for (const attempt of [1, 2]) {
    const frames = join(dir, `frames-${attempt}`);
    await mkdir(frames);
    const out = join(dir, `fixture-${attempt}.webm`);
    const r = await xcursus([
      "export",
      "video",
      project,
      "--itinerary",
      join(fixtureDir, "itinerary.json"),
      "--fps",
      "30",
      "--out",
      out,
      "--frames",
      frames,
    ]);
    expect(r.code, r.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(`${out}.manifest.json`, "utf8"));
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,nb_read_frames,width,height:format=duration",
      "-of",
      "json",
      out,
    ]);
    const probe = JSON.parse(stdout);
    runs.push({ out, frames, manifest, probe });
  }
  const [first, second] = runs as [(typeof runs)[0], (typeof runs)[0]];
  const expectedFrames = Math.ceil((plan.value.totalMs * 30) / 1000);
  expect(plan.value.totalMs).toBe(4800);
  expect(Number(first.probe.streams[0].nb_read_frames)).toBe(expectedFrames);
  expect(
    Math.abs(
      Number(first.probe.format.duration) * 1000 - (expectedFrames * 1000) / 30,
    ),
  ).toBeLessThanOrEqual(1000 / 30);
  expect(first.probe.streams[0]).toMatchObject({ width: 1280, height: 720 });
  expect(["vp9", "vp8", "av1"]).toContain(first.probe.streams[0].codec_name);
  expect(first.manifest.environment.frames).toMatchObject({
    fps: 30,
    frameCount: expectedFrames,
    planMs: 4800,
    finalHoldVisible: true,
  });
  expect(first.manifest.itinerary.reducedMotion).toBe(false);
  // Logged poses are the core sampler's, endpoint included.
  for (const s of first.manifest.environment.frames.samples) {
    const expected = sampleCapture(plan.value, s.t);
    expect(s.nodeId).toBe(expected.nodeId);
    expect(s.phase).toBe(expected.phase);
    [...s.camera.position, ...s.camera.rotation, s.camera.zoom].forEach(
      (x: number, i: number) =>
        expect(
          Math.abs(
            x -
              [
                ...expected.camera.position,
                ...expected.camera.rotation,
                expected.camera.zoom,
              ][i]!,
          ),
        ).toBeLessThanOrEqual(1e-6),
    );
  }
  const end = sampleCapture(plan.value, plan.value.totalMs).camera;
  const last = plan.value.visits.at(-1)!.camera;
  [...end.position, ...end.rotation, end.zoom].forEach((x, i) =>
    expect(
      Math.abs(x - [...last.position, ...last.rotation, last.zoom][i]!),
    ).toBeLessThanOrEqual(1e-6),
  );
  // Same environment, same timing, poses and pixels.
  expect(second.manifest.environment.frames.framesSha256).toBe(
    first.manifest.environment.frames.framesSha256,
  );
  expect(second.manifest.environment.frames.samples).toEqual(
    first.manifest.environment.frames.samples,
  );
  // The final hold shows the arrival pose: every frame from the last arrival on is the same image.
  const names = (await readdir(first.frames)).sort();
  expect(names).toHaveLength(expectedFrames);
  const hash = async (n: string) =>
    createHash("sha256")
      .update(await readFile(join(first.frames, n)))
      .digest("hex");
  const arrival = Math.ceil((plan.value.visits.at(-1)!.arrivalMs * 30) / 1000);
  expect(await hash(names[arrival]!)).toBe(await hash(names.at(-1)!));
  expect(await hash(names[0]!)).not.toBe(await hash(names.at(-1)!));
  // Decoded frames 0, middle and last against the captured PNGs (lossy VP9: small mean difference).
  const report: Record<string, number> = {};
  for (const index of [0, Math.floor(expectedFrames / 2), expectedFrames - 1]) {
    const decoded = join(dir, `decoded-${index}.png`);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      first.out,
      "-vf",
      `select=eq(n\\,${index})`,
      "-fps_mode",
      "vfr",
      "-frames:v",
      "1",
      decoded,
    ]);
    report[index] = await difference(
      decoded,
      join(first.frames, names[index]!),
    );
    expect(report[index]).toBeLessThan(4);
  }
  await writeEvidence(`distribution/${browserName}/video/summary.json`, {
    frames: expectedFrames,
    probe: first.probe,
    decodedDifference: report,
    framesSha256: first.manifest.environment.frames.framesSha256,
  });
});

test("capture environment errors: failing FFmpeg exits 3, missing Chromium exits 2, no output left", async ({
  browserName,
}) => {
  const dir = await outDir("errors", browserName);
  const fake = join(dir, "fake-ffmpeg");
  await writeFile(
    fake,
    `#!/bin/sh\ncase "$*" in\n  *-version*) echo "ffmpeg version fake"; exit 0;;\n  *-encoders*) echo " V....D libvpx-vp9  fake"; exit 0;;\n  *) echo "simulated encoder failure" >&2; exit 1;;\nesac\n`,
  );
  await chmod(fake, 0o755);
  const out = join(dir, "broken.webm");
  const failed = await xcursus(
    [
      "export",
      "video",
      project,
      "--itinerary",
      join(fixtureDir, "itinerary.json"),
      "--out",
      out,
    ],
    { XCURSUS_FFMPEG: fake, XCURSUS_FFPROBE: fake },
  );
  expect(failed.code).toBe(3);
  expect(failed.stderr).toContain("simulated encoder failure");
  expect((await readdir(dir)).filter((f) => f.includes("broken"))).toEqual([]);
  const noBrowser = await xcursus(
    [
      "export",
      "pdf",
      project,
      "--itinerary",
      join(fixtureDir, "itinerary.json"),
      "--out",
      join(dir, "x.pdf"),
    ],
    { PLAYWRIGHT_BROWSERS_PATH: join(dir, "no-browsers") },
  );
  expect(noBrowser.code).toBe(2);
  expect(noBrowser.stderr).toContain("install chromium");
  expect((await readdir(dir)).filter((f) => f.startsWith("x.pdf"))).toEqual([]);
});

test("exported HTML on a narrow touch screen: swipes are never taken by the browser and the outline ends above the buttons", async ({
  page,
  browserName,
}) => {
  const dir = await outDir("narrow", browserName);
  const out = join(dir, "narrow.html");
  const r = await xcursus(["export", "html", project, "--out", out]);
  expect(r.code, r.stderr).toBe(0);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(pathToFileURL(out).href);
  await page.waitForFunction(
    () => document.documentElement.dataset.xcursus === "ready",
  );
  // touch-action stops at every scroll container: each one in the stage
  // keeps pan-y (code blocks and the outline excepted), so a horizontal
  // swipe on scene content is not cancelled by the browser.
  const scrollers = await page.evaluate(() => {
    const stage = document.getElementById("xcursus-stage")!;
    return [stage, ...stage.querySelectorAll<Element>("*")]
      .filter((e) => {
        const style = getComputedStyle(e);
        return style.overflowX !== "visible" || style.overflowY !== "visible";
      })
      .filter((e) => !e.closest("pre, .xc-outline"))
      .map((e) => ({
        element: `${e.tagName}.${e.getAttribute("class") ?? ""}`,
        touchAction: getComputedStyle(e).touchAction,
      }));
  });
  expect(scrollers.length).toBeGreaterThan(3);
  expect(scrollers.filter((s) => s.touchAction !== "pan-y")).toEqual([]);
  // Text view: the bar wraps at this width; the outline fits below it and,
  // scrolled to the end, its last line is above the on-screen buttons.
  await page.getByRole("button", { name: "Text view" }).click();
  const fit = await page.evaluate(() => {
    const outline = document.querySelector<HTMLElement>(".xc-outline")!;
    outline.scrollTop = outline.scrollHeight;
    const last = [...outline.querySelectorAll("p, button")]
      .at(-1)!
      .getBoundingClientRect();
    const buttons = [
      ...document.querySelectorAll(
        'nav[aria-label="Presentation navigation"] button',
      ),
    ].map((b) => b.getBoundingClientRect().top);
    return {
      outlineBottom: outline.getBoundingClientRect().bottom,
      viewport: innerHeight,
      lastBottom: last.bottom,
      buttonsTop: Math.min(...buttons),
    };
  });
  expect(fit.outlineBottom).toBeLessThanOrEqual(fit.viewport + 1);
  expect(fit.lastBottom).toBeLessThanOrEqual(fit.buttonsTop);
});
