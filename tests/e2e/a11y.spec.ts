import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./runner.js";
import { studioURL, writeEvidence } from "./evidence.js";

const axeSource = readFile(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);
// axe is injected as a script; the pages keep their own CSP otherwise.
test.use({ bypassCSP: true });
interface AxeResult {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[] }>;
}
/**
 * Motivated exceptions: none are needed today. Each entry must name the rule,
 * the selector it applies to and why the finding is a false positive.
 */
const exceptions: Array<{ rule: string; target: RegExp; reason: string }> = [];
async function audit(
  page: Page,
  name: string,
  info: { project: { name: string } },
) {
  await page.addScriptTag({ content: await axeSource });
  const results = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: unknown,
          ) => Promise<{ violations: AxeResult[]; passes: unknown[] }>;
        };
      }
    ).axe;
    const run = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22aa",
          "best-practice",
        ],
      },
      resultTypes: ["violations"],
    });
    return {
      violations: run.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({ target: n.target })),
      })),
    };
  });
  const severe = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      ...v,
      nodes: v.nodes.filter(
        (n) =>
          !exceptions.some(
            (e) => e.rule === v.id && e.target.test(n.target.join(" ")),
          ),
      ),
    }))
    .filter((v) => v.nodes.length);
  await writeEvidence(`axe/${info.project.name}-${name}.json`, results);
  expect(
    severe.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} → ${v.nodes
          .map((n) => n.target.join(" "))
          .slice(0, 5)
          .join(", ")}`,
    ),
  ).toEqual([]);
}
for (const route of ["/core", "/structure", "/content", "/layout"])
  test(`axe: playground ${route} has no serious or critical violations`, async ({
    page,
  }, info) => {
    await page.goto(route);
    await expect(page.locator(".xc-player")).toHaveCount(2);
    await expect(
      page
        .locator('.xc-block [role="status"]')
        .filter({ hasText: "Loading local resource" }),
    ).toHaveCount(0);
    await audit(page, route.slice(1), info);
    await page.getByRole("button", { name: "Text view" }).first().click();
    await audit(page, `${route.slice(1)}-outline`, info);
  });
test("axe: Studio empty, with content and dialogs has no serious or critical violations", async ({
  page,
}, info) => {
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  await audit(page, "studio-empty", info);
  await page
    .getByLabel("JSON project file")
    .setInputFiles("examples/content-gallery/content-gallery.xcursus");
  await expect(
    page.getByRole("list", { name: "Scene list" }).locator("li"),
  ).toHaveCount(11);
  await page
    .getByRole("list", { name: "Scene list" })
    .getByRole("button")
    .nth(7)
    .click();
  await audit(page, "studio-content", info);
  await page.getByRole("button", { name: "Delete scene" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "studio-dialog", info);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-player .xc-player")).toHaveCount(1);
  await audit(page, "studio-presentation", info);
});
test("axe: Studio scene editor, its panels and the theme have no serious or critical violations", async ({
  page,
}, info) => {
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  await page
    .getByLabel("JSON project file")
    .setInputFiles("examples/layout-canvas/layout-canvas.xcursus");
  await expect(page.getByLabel("Project title")).toHaveValue(
    "Layout inside the scene",
  );
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await expect(page.locator("[data-layout-block]")).toHaveCount(5);
  await page.locator('[data-layout-block="summary"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".layout-handle")).toHaveCount(9);
  await audit(page, "studio-layout", info);
  await page.getByRole("tab", { name: /^Theme/ }).click();
  await audit(page, "studio-theme", info);
});
