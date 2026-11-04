import { readFile } from "node:fs/promises";
import { expect, test } from "./runner.js";
import { writeEvidence } from "./evidence.js";
import type { Page } from "@playwright/test";

// Child scenes 30 px in front of a very large section, with another large
// or turned plane in the document: Firefox sorted them behind the section
// and painted only its background. The player now paints the wrappers in a
// split-minimizing order in that engine; every engine must show the child.
const cases: Array<{
  file: string;
  parent: [number, number, number];
  children: string[];
}> = [
  {
    file: "tests/fixtures/paint/tilted-section.json",
    parent: [0xed, 0xe9, 0xfe],
    children: ["left", "middle"],
  },
  {
    file: "tests/fixtures/paint/wide-sections.json",
    parent: [0xf0, 0xf4, 0xf8],
    children: ["first", "second"],
  },
];

/** Share of the centre of the stage painted in the parent section's colour. */
async function parentShare(page: Page, colour: [number, number, number]) {
  const shot = await page.screenshot({
    clip: { x: 540, y: 310, width: 200, height: 100 },
  });
  return page.evaluate(
    async ([b64, rgb]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const g = canvas.getContext("2d")!;
      g.drawImage(image, 0, 0);
      const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4)
        if (
          Math.abs(px[i]! - rgb[0]!) < 5 &&
          Math.abs(px[i + 1]! - rgb[1]!) < 5 &&
          Math.abs(px[i + 2]! - rgb[2]!) < 5
        )
          n++;
      return n / (px.length / 4);
    },
    [shot.toString("base64"), colour] as const,
  );
}

for (const c of cases)
  test(`child scenes in front of a large section are drawn: ${c.file.split("/").at(-1)}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/core");
    await expect(page.locator(".xc-player")).toHaveCount(2);
    const json = await readFile(c.file, "utf8");
    await page.evaluate(async (text) => {
      const host = document.createElement("div");
      host.id = "paint-host";
      host.style.cssText =
        "position:fixed;left:0;top:0;width:1280px;height:720px;z-index:10";
      document.body.append(host);
      const player = window.createDemoPlayer({ controls: false });
      const mounted = await player.mount(host, JSON.parse(text));
      if (!mounted.ok) throw new Error(JSON.stringify(mounted.diagnostics));
      (window as unknown as { paintPlayer: typeof player }).paintPlayer =
        player;
    }, json);
    const results: Record<string, number> = {};
    for (const child of c.children) {
      await page.evaluate(async (nodeId) => {
        const player = (
          window as unknown as {
            paintPlayer: ReturnType<typeof window.createDemoPlayer>;
          }
        ).paintPlayer;
        await player.goTo({ nodeId }, { durationMs: 0 });
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
      }, child);
      results[child] = await parentShare(page, c.parent);
      // The child card fills the centre: no trace of the section behind it.
      expect(results[child], `${child} hidden behind its section`).toBe(0);
    }
    // The order is an engine workaround: only Gecko gets explicit z-indexes.
    const zIndexes = await page
      .locator("#paint-host [data-scene-id]")
      .evaluateAll((wrappers) => wrappers.map((w) => w.style.zIndex));
    if (info.project.name === "firefox")
      expect(zIndexes.every((z) => z !== "")).toBe(true);
    else expect(zIndexes.every((z) => z === "")).toBe(true);
    await writeEvidence(
      `paint-${c.file.split("/").at(-1)}-${info.project.name}.json`,
      { parentShareAtCentre: results, zIndexes },
    );
  });
