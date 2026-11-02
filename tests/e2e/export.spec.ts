import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import {
  firstPassItinerary,
  validateDocument,
} from "../../packages/core/src/index.js";
import { expect, test } from "./runner.js";
import { evidencePath, studioURL } from "./evidence.js";

// Export panel of Studio (0.6): the standalone HTML is written in the browser
// by the CLI's own pipeline; PDF and video go through the command line with
// the archive and the itinerary the panel saves.
const run = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /\/$/,
  "",
);
const fixture = join(root, "examples/distribution-static/project.json");
/** The workspace CLI built by `pnpm build`; the tarball CLI is covered by distribution.spec. */
async function xcursus(args: string[]) {
  try {
    const r = await run(
      process.execPath,
      [join(root, "packages/cli/dist/cli.js"), ...args],
      { cwd: root, timeout: 300000, maxBuffer: 16 * 1024 * 1024 },
    );
    return { code: 0, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number; stderr?: string };
    return { code: e.code ?? -1, stderr: e.stderr ?? "" };
  }
}
async function outDir(name: string, browser: string) {
  const dir = evidencePath(`export/${browser}/${name}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}
/** The distribution fixture as a .xcursus archive, optionally altered. */
async function archive(
  dir: string,
  alter?: (doc: { scenes: Array<{ blocks: unknown[] }> }) => void,
) {
  let project = fixture;
  if (alter) {
    const doc = JSON.parse(await readFile(fixture, "utf8"));
    alter(doc);
    await mkdir(join(dir, "src/assets"), { recursive: true });
    await writeFile(
      join(dir, "src/assets/orbit.svg"),
      await readFile(
        join(root, "examples/distribution-static/assets/orbit.svg"),
      ),
    );
    project = join(dir, "src/project.json");
    await writeFile(project, JSON.stringify(doc));
  }
  const out = join(dir, "fixture.xcursus");
  const r = await xcursus(["pack", project, "--out", out]);
  expect(r.code, r.stderr).toBe(0);
  return out;
}
async function openInStudio(page: Page, file: string) {
  await page.goto(studioURL);
  await page.getByLabel("JSON project file").setInputFiles(file);
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(3);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  return page.getByRole("dialog", { name: "Export" });
}
async function save(page: Page, dir: string, click: () => Promise<void>) {
  const download = page.waitForEvent("download");
  await click();
  const file = await download;
  const path = join(dir, file.suggestedFilename());
  await file.saveAs(path);
  return path;
}

test("Studio downloads the same standalone HTML as the CLI, and it opens offline from file://", async ({
  page,
  browserName,
}) => {
  const dir = await outDir("html", browserName);
  const input = await archive(dir);
  const cliHtml = join(dir, "cli.html");
  const r = await xcursus(["export", "html", input, "--out", cliHtml]);
  expect(r.code, r.stderr).toBe(0);

  const panel = await openInStudio(page, input);
  await expect(panel.getByRole("combobox").first()).toHaveValue("en");
  const studioHtml = await save(page, dir, () =>
    panel.getByRole("button", { name: "Download HTML" }).click(),
  );
  expect(studioHtml.endsWith("Distribution_fixture.html")).toBe(true);
  await expect(panel.getByRole("status")).toContainText("complete");

  // One pipeline: only the tool named in the header differs.
  const html = await readFile(studioHtml, "utf8");
  expect(html).toContain('<meta name="generator" content="XCursus Studio ');
  expect(html.replaceAll("XCursus Studio ", "XCursus CLI ")).toBe(
    await readFile(cliHtml, "utf8"),
  );
  expect(html).not.toContain("PRIVATE-NOTE");

  // Opened from disk with every http(s)/ws(s) request aborted and counted.
  const audience = await page.context().newPage();
  const requests: string[] = [];
  audience.on("request", (q) => requests.push(q.url()));
  await audience.context().route(/^(https?|wss?):/, (route) => route.abort());
  await audience.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await audience.goto(pathToFileURL(studioHtml).href);
  await expect(audience.locator(".xc-player")).toHaveCount(1);
  await expect(
    audience.locator('.xc-scene[data-scene-id="cover"]'),
  ).toHaveCount(1);
  await audience.locator("#xcursus-stage").focus();
  await audience.keyboard.press("ArrowRight");
  await expect(audience.locator(".xc-live")).toHaveText(
    "Flow scene with Markdown",
  );
  expect(await audience.content()).not.toContain("PRIVATE-NOTE");
  expect(requests.filter((u) => /^(https?|wss?):/.test(u))).toEqual([]);
  expect(await audience.evaluate(() => window.cspViolations)).toEqual([]);
  await audience.close();
});

test("export panel: strict refusal, placeholders, itinerary and working CLI commands", async ({
  page,
  browserName,
}) => {
  const dir = await outDir("panel", browserName);
  const input = await archive(dir, (doc) =>
    doc.scenes[1]!.blocks.push({
      id: "web",
      type: "embed",
      data: { url: "https://example.org/", title: "Remote" },
    }),
  );
  const panel = await openInStudio(page, input);
  // Strict: nothing is downloaded and the finding is named.
  let downloads = 0;
  page.on("download", () => downloads++);
  await panel.getByRole("button", { name: "Download HTML" }).click();
  await expect(panel.getByRole("status")).toContainText("Not exported");
  await expect(panel.getByRole("status")).toContainText("EMBED_REMOTE");
  expect(downloads).toBe(0);
  await panel
    .getByRole("checkbox", { name: "Replace unsupported content" })
    .check();
  const partial = await save(page, dir, () =>
    panel.getByRole("button", { name: "Download HTML" }).click(),
  );
  await expect(panel.getByRole("status")).toContainText("partial");
  expect(await readFile(partial, "utf8")).toContain(
    '"placeholders":{"embed":"excluded"}',
  );

  // The proposed itinerary: n1 → n2 → n3, stopping before the loop back.
  await expect(
    panel.getByRole("list", { name: "Itinerary visits" }).locator("li"),
  ).toHaveText(["Export fixture", "Flow scene with Markdown", /.+/]);
  await expect(panel).toContainText("the itinerary stops before it");
  const itinerary = await save(page, dir, () =>
    panel.getByRole("button", { name: "Download itinerary" }).click(),
  );
  const doc = validateDocument(await readFile(fixture, "utf8"));
  if (!doc.ok) throw Error();
  const expected = firstPassItinerary(doc.value);
  if (!expected.ok) throw Error();
  expect(JSON.parse(await readFile(itinerary, "utf8"))).toEqual(
    expected.value.itinerary,
  );
  const saved = await save(page, dir, () =>
    panel.getByRole("button", { name: "Save archive" }).click(),
  );
  const commands = await panel.locator(".export-command code").allInnerTexts();
  expect(commands).toEqual([
    "xcursus export pdf Distribution_fixture.xcursus --itinerary Distribution_fixture.itinerary.json --out Distribution_fixture.pdf",
    "xcursus export video Distribution_fixture.xcursus --itinerary Distribution_fixture.itinerary.json --fps 30 --out Distribution_fixture.webm",
  ]);
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);

  // The command runs on the files the panel saved (one capture engine: Chromium).
  if (browserName !== "chromium") return;
  const pdf = join(dir, "Distribution_fixture.pdf");
  const args = commands[0]!.split(" ").slice(1);
  const r = await xcursus([
    ...args.slice(0, 2),
    saved,
    "--itinerary",
    itinerary,
    "--out",
    pdf,
    "--allow-partial",
  ]);
  expect(r.code, r.stderr).toBe(0);
  const manifest = JSON.parse(await readFile(`${pdf}.manifest.json`, "utf8"));
  expect(manifest.verification).toMatchObject({ pageCount: 3 });
});
