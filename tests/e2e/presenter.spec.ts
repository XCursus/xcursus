import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { validateDocument } from "../../packages/core/src/index.js";
import type { ProjectDocument } from "../../packages/core/src/index.js";
import branching from "../../examples/structure-branching/project.json" with { type: "json" };
import { expect, test } from "./runner.js";
import { studioURL, writeEvidence } from "./evidence.js";
declare global {
  interface Window {
    publicPlayer?: import("../../packages/player/src/index.js").Player;
  }
}
// 0.6 presenter view: Studio console (the only navigation authority) and a
// real public window opened by the user's click; two pages of one context.
const PUBLIC = "http://127.0.0.1:4174/present.html";
/**
 * The branching fixture with private notes on every scene. A stays a manual
 * branch; B→D and C→D become visit-limited, so `next` follows them without
 * a choice (every cycle edge still has an explicit condition).
 */
function deck(): ProjectDocument {
  const r = validateDocument(branching);
  if (!r.ok) throw Error();
  const d = r.value;
  for (const s of d.scenes)
    s.notes = `PRIVATE-NOTE ${s.id}: say this only to yourself`;
  for (const e of d.paths[0]!.edges)
    if (e.id === "BD" || e.id === "CD")
      e.condition = { kind: "visit-limit", maxVisits: 2 };
  return d;
}
async function openStudio(page: Page, document: ProjectDocument = deck()) {
  await page.goto(studioURL);
  await expect(page.locator(".preview-player .xc-player")).toHaveCount(1);
  await page.getByLabel("JSON project file").setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.studio!.store.getSnapshot().document.scenes.length,
      ),
    )
    .toBe(document.scenes.length);
}
async function startPresenter(page: Page) {
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Presenter" }).click(),
  ]);
  await popup.waitForLoadState();
  await expect(popup.locator("html")).toHaveAttribute(
    "data-presenter",
    "connected",
  );
  const console = page.getByRole("region", { name: "Presenter view" });
  await expect(console.getByRole("status").first()).toHaveText(
    "Audience window connected",
  );
  return { popup, console };
}
const publicNode = (popup: Page) =>
  popup.evaluate(() => window.publicPlayer!.getState().nodeId);

test("presenter and public window: synced navigation and branches, private notes, timer and muted previews", async ({
  page,
}) => {
  await openStudio(page);
  const { popup, console } = await startPresenter(page);
  await expect(
    console.getByRole("region", { name: "Speaker notes" }),
  ).toContainText("PRIVATE-NOTE A");
  expect(await publicNode(popup)).toBe("A");
  // A is a manual branch: the presenter offers both exits, the public waits.
  await expect(
    console.getByRole("list", { name: "Branch choices" }).getByRole("button"),
  ).toHaveCount(2);
  await console
    .getByRole("list", { name: "Branch choices" })
    .getByRole("button", { name: "Explore B" })
    .click();
  await expect.poll(() => publicNode(popup)).toBe("B");
  await expect(
    console.getByRole("region", { name: "Speaker notes" }),
  ).toContainText("PRIVATE-NOTE B");
  // Keyboard on the presenter console moves both windows.
  await console.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => publicNode(popup)).toBe("D");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => publicNode(popup)).toBe("B");
  // Keys in the public window are requests to the presenter, never local navigation.
  await popup.locator("#stage").focus();
  await popup.keyboard.press("ArrowRight");
  await expect.poll(() => publicNode(popup)).toBe("D");
  await expect(
    console.getByRole("region", { name: "Speaker notes" }),
  ).toContainText("PRIVATE-NOTE D");
  // Notes never reach the public window, its DOM or its renderers.
  expect(await popup.content()).not.toContain("PRIVATE-NOTE");
  expect(await popup.evaluate(() => document.body.innerText)).not.toContain(
    "PRIVATE-NOTE",
  );
  // Previews in the presenter are muted; the public window is the only one with sound.
  expect(
    await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLMediaElement>(
          ".presenter audio, .presenter video",
        ),
      ].every((m) => m.muted),
    ),
  ).toBe(true);
  // Monotonic timer: start, pause keeps the value, reset.
  const timer = console.getByLabel("Elapsed time");
  await expect(timer).toHaveText("00:00");
  await console.getByRole("button", { name: "Start" }).click();
  await expect(timer).toHaveText("00:01", { timeout: 4000 });
  await console.getByRole("button", { name: "Pause" }).click();
  const paused = await timer.textContent();
  await page.waitForTimeout(1200);
  await expect(timer).toHaveText(paused!);
  await console.getByRole("button", { name: "Reset" }).click();
  await expect(timer).toHaveText("00:00");
  await writeEvidence("presenter/sync.json", {
    publicNode: await publicNode(popup),
  });
  await console.getByRole("button", { name: "End" }).click();
  await expect(
    page.getByRole("region", { name: "Presenter view" }),
  ).toHaveCount(0);
});

test("a single manual exit is offered as a choice, not previewed as the next visit", async ({
  page,
}) => {
  // The fixture as authored: B has one exit, B→D, and it is manual.
  const document = deck();
  const edge = document.paths[0]!.edges.find((e) => e.id === "BD")!;
  edge.condition = { kind: "manual" };
  await openStudio(page, document);
  const { popup, console } = await startPresenter(page);
  const choices = console
    .getByRole("list", { name: "Branch choices" })
    .getByRole("button");
  await choices.filter({ hasText: "Explore B" }).click();
  await expect.poll(() => publicNode(popup)).toBe("B");
  // `next` would ask for a choice: the console asks too, with no stale preview.
  await expect(choices).toHaveText(["Conclusion from B"]);
  const following = console.getByRole("region", { name: "Next" });
  await expect(following.locator(".presenter-player")).toBeHidden();
  await expect(following.locator(":scope > h3")).toHaveText("Next");
  await choices.click();
  await expect.poll(() => publicNode(popup)).toBe("D");
});

test("paths that reuse node IDs: the console shows the scene and notes of the presented path", async ({
  page,
}) => {
  // Node IDs are unique per path: the default path, listed after the branching
  // one, reuses A and B for other scenes.
  const document = deck();
  document.paths.push({
    id: "reuse",
    name: "Same IDs",
    startNodeId: "A",
    nodes: [
      { id: "A", sceneId: "C", holdMs: 0 },
      { id: "B", sceneId: "D", holdMs: 0 },
    ],
    edges: [
      {
        id: "reuse-AB",
        from: "A",
        to: "B",
        label: "",
        transition: { durationMs: 300, easing: "linear" },
      },
    ],
  });
  document.defaultPathId = "reuse";
  await openStudio(page, document);
  const { popup, console } = await startPresenter(page);
  const notes = console.getByRole("region", { name: "Speaker notes" });
  expect(
    await popup.evaluate(() => window.publicPlayer!.getState().sceneId),
  ).toBe("C");
  await expect(notes).toContainText("PRIVATE-NOTE C");
  await expect(
    console
      .getByRole("region", { name: "Current scene" })
      .locator(":scope > h3"),
  ).toContainText("C · Alternative");
  await expect(
    console.getByRole("region", { name: "Next" }).locator(":scope > h3"),
  ).toContainText("D · Conclusion");
  await console.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() => popup.evaluate(() => window.publicPlayer!.getState().sceneId))
    .toBe("D");
  await expect(notes).toContainText("PRIVATE-NOTE D");
});

test("reloads resynchronize from a snapshot: public window and presenter tab", async ({
  page,
}) => {
  await openStudio(page);
  const { popup, console } = await startPresenter(page);
  await console
    .getByRole("list", { name: "Branch choices" })
    .getByRole("button", { name: "Explore C" })
    .click();
  await expect.poll(() => publicNode(popup)).toBe("C");
  // Public reload: new epoch, hello, snapshot with the history, no replay.
  await popup.reload();
  await expect(popup.locator("html")).toHaveAttribute(
    "data-presenter",
    "connected",
  );
  await expect.poll(() => publicNode(popup)).toBe("C");
  expect(
    await popup.evaluate(() =>
      window.publicPlayer!.getState().history.map((v) => v.nodeId),
    ),
  ).toEqual(["A", "C"]);
  await console.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => publicNode(popup)).toBe("D");
  // Presenter reload: the session survives in sessionStorage and adopts the
  // same public window on its next hello.
  page.on("dialog", (d) => void d.accept());
  await page.reload();
  // The reloaded tab must open the presented project again before resuming.
  await expect(
    page.getByRole("button", { name: "Resume presenter view" }),
  ).toBeDisabled();
  await page.getByLabel("JSON project file").setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(deck())),
  });
  await page.getByRole("button", { name: "Resume presenter view" }).click();
  const resumed = page.getByRole("region", { name: "Presenter view" });
  await expect(resumed.getByRole("status").first()).toHaveText(
    "Audience window connected",
    { timeout: 10000 },
  );
  // The resumed console starts at the path start and sends its own snapshot.
  await expect.poll(() => publicNode(popup)).toBe("A");
  await resumed
    .getByRole("list", { name: "Branch choices" })
    .getByRole("button", { name: "Explore B" })
    .click();
  await expect.poll(() => publicNode(popup)).toBe("B");
});

test("messages with a wrong source, session, sequence or origin are ignored", async ({
  page,
  context,
}) => {
  await openStudio(page);
  const { popup } = await startPresenter(page);
  const sessionId = (await page.evaluate(() =>
    sessionStorage.getItem("xcursus-presenter-session"),
  ))!;
  const forged = (session: string, type = "navigate") => ({
    protocol: "xcursus-presenter/1",
    sessionId: session,
    epoch: "f".repeat(32),
    seq: 1,
    from: "presenter",
    type,
    command: { kind: "next", edgeId: "AB" },
  });
  const named = `xcursus-public-${sessionId}`;
  // Wrong source: the public window posts to itself, not from its opener.
  await popup.evaluate(
    (m) => window.postMessage(m, location.origin),
    forged(sessionId),
  );
  // Right source (the presenter tab reaches its named popup), wrong session.
  await page.evaluate(
    ([m, name]) => window.open("", name)!.postMessage(m, location.origin),
    [forged("0".repeat(32)), named] as const,
  );
  // Right source and session, but a new epoch that does not start with a snapshot.
  await page.evaluate(
    ([m, name]) => window.open("", name)!.postMessage(m, location.origin),
    [forged(sessionId), named] as const,
  );
  // Malformed command from the right source.
  await page.evaluate(
    ([m, name]) => window.open("", name)!.postMessage(m, location.origin),
    [
      { ...forged(sessionId), command: { kind: "eval", code: "1" } },
      named,
    ] as const,
  );
  await popup.waitForTimeout(500);
  expect(await publicNode(popup)).toBe("A");
  // Another origin opens its own public window with the same session ID: it never connects.
  const other = await context.newPage();
  await other.goto("http://127.0.0.1:4173/core");
  const [stranger] = await Promise.all([
    other.waitForEvent("popup"),
    other.evaluate((url) => {
      (window as unknown as { stranger: Window | null }).stranger = window.open(
        url,
        "_blank",
      );
    }, `${PUBLIC}#session=${sessionId}`),
  ]);
  await stranger.waitForLoadState();
  await other.evaluate(
    (m) =>
      (window as unknown as { stranger: Window }).stranger.postMessage(m, "*"),
    {
      ...forged(sessionId, "snapshot"),
      snapshot: { document: {}, assets: {}, pathId: null, visits: [] },
    },
  );
  await stranger.waitForTimeout(2500);
  await expect(stranger.locator("html")).toHaveAttribute(
    "data-presenter",
    "waiting",
  );
  expect(
    await stranger.evaluate(() => window.publicPlayer!.getState().status),
  ).toBe("unmounted");
  expect(await publicNode(popup)).toBe("A");
});

test("a blocked popup falls back to instructions and a single-window presentation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await openStudio(page);
  await page.getByRole("button", { name: "Presenter" }).click();
  const console = page.getByRole("region", { name: "Presenter view" });
  await expect(console.getByRole("alert")).toContainText(
    "The browser blocked the audience window",
  );
  await console.getByRole("button", { name: "Present in this tab" }).click();
  await expect(
    page.getByRole("region", { name: "Presentation mode" }),
  ).toBeVisible();
  await expect(page.locator(".presentation-player .xc-player")).toHaveCount(1);
  expect(await page.locator(".presentation-player").innerText()).not.toContain(
    "PRIVATE-NOTE",
  );
});

test("the public page alone, without the presenter, explains how to open it", async ({
  page,
}) => {
  await page.goto(`${PUBLIC}#session=${"a".repeat(32)}`);
  await expect(page.locator("html")).toHaveAttribute(
    "data-presenter",
    "no-opener",
  );
  await expect(page.getByRole("status")).toContainText(
    "Open this window from the Presenter button",
  );
  expect(
    await readFile(
      new URL("../../apps/studio/present.html", import.meta.url),
      "utf8",
    ),
  ).not.toContain("react");
});
