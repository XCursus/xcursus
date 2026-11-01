import { expect, test } from "./runner.js";
import { evidencePath } from "./evidence.js";
import type { Player, PlayerOptions } from "../../packages/player/src/index.js";
import type { ProjectDocument } from "../../packages/core/src/index.js";
declare global {
  interface Window {
    demoPlayers: Player[];
    createDemoPlayer: (options?: PlayerOptions) => Player;
    demoDocument: ProjectDocument;
  }
}
test.beforeEach(async ({ page }) => {
  await page.goto("/core");
  await expect(page.locator(".xc-player")).toHaveCount(2);
});
test("three scenes project independent corner landmarks and fit in the viewport", async ({
  page,
}, info) => {
  for (const [nodeId, sceneId] of [
    ["n1", "intro"],
    ["n2", "detail"],
    ["n3", "end"],
  ]) {
    expect(
      await page.evaluate(
        async (nodeId) =>
          (
            await window.demoPlayers[0]!.goTo(
              { nodeId: nodeId! },
              { durationMs: 0 },
            )
          ).status,
        nodeId,
      ),
    ).toMatch(/completed|noop/);
    const measurements = await page.evaluate((sceneId) => {
      const scene = window.demoDocument.scenes.find((s) => s.id === sceneId)!;
      const wrapper = document.querySelector<HTMLElement>(
        `#player-1 [data-scene-id="${sceneId}"]`,
      )!;
      const stage = document
        .querySelector("#player-1 .xc-stage")!
        .getBoundingClientRect();
      const fit = Math.min(stage.width / 1280, stage.height / 720);
      const zoom = 0.9 * Math.min(1280 / scene.size[0], 720 / scene.size[1]);
      const points = [
        [-scene.size[0] / 2, -scene.size[1] / 2],
        [0, 0],
        [scene.size[0] / 2, scene.size[1] / 2],
      ].map(([x, y]) => {
        const marker = document.createElement("span");
        marker.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:1px;height:1px;background:red`;
        wrapper.append(marker);
        const actual = marker.getBoundingClientRect();
        marker.remove();
        return {
          x: actual.x,
          y: actual.y,
          expectedX: stage.x + stage.width / 2 + x! * zoom * fit,
          expectedY: stage.y + stage.height / 2 + y! * zoom * fit,
        };
      });
      return points;
    }, sceneId);
    for (const p of measurements) {
      expect(Math.abs(p.x - p.expectedX)).toBeLessThan(1);
      expect(Math.abs(p.y - p.expectedY)).toBeLessThan(1);
    }
    if (info.project.name === "chromium")
      await page.locator("#player-1 .xc-player").screenshot({
        path: evidencePath(`regressions/scene-${sceneId}.png`),
      });
  }
});
test("local keyboard, focus and text fields isolate two instances", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#player-1").focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator('#player-1 [data-scene-id="detail"] h2'),
  ).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.demoPlayers.map((p) => p.getState().nodeId),
    ),
  ).toEqual(["n2", "n1"]);
  await page.getByRole("textbox", { name: "Test input 1" }).focus();
  await page.keyboard.press("ArrowRight");
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().nodeId),
  ).toBe("n2");
  await page.locator("#player-2").focus();
  await page.keyboard.press("ArrowRight");
  expect(
    await page.evaluate(() =>
      window.demoPlayers.map((p) => p.getState().nodeId),
    ),
  ).toEqual(["n2", "n2"]);
});
test("outline reads all text in path order and navigates with reduced motion", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .locator("#player-1")
    .getByRole("button", { name: "Text view" })
    .click();
  const outline = page.locator("#player-1 .xc-outline");
  await expect(outline).toBeVisible();
  await expect(outline.locator("p")).toHaveText([
    "XCursus",
    "A different perspective",
    "Connecting ideas",
  ]);
  await outline.getByRole("button", { name: "Conclusion" }).click();
  await expect(
    outline.getByRole("button", { name: "Conclusion" }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().nodeId),
  ).toBe("n3");
  expect(
    await page
      .locator("#player-1 .xc-content")
      .evaluateAll((els) =>
        els.every((el) => el.getAttribute("aria-hidden") === "true"),
      ),
  ).toBe(true);
  if (info.project.name === "chromium")
    await page.locator("#player-1 .xc-player").screenshot({
      path: evidencePath("regressions/outline.png"),
    });
});
test("latest-wins, invalid commands, AbortSignal, event order and changing motion", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const p = window.demoPlayers[0]!,
      events: string[] = [];
    for (const name of [
      "navigationstart",
      "navigationcancel",
      "scenechange",
      "navigationend",
    ] as const)
      p.on(name, () => events.push(name));
    const commands = Array.from({ length: 10 }, () => p.next());
    await p.goTo({ nodeId: "unknown" });
    const statuses = (await Promise.all(commands)).map((r) => r.status);
    const ac = new AbortController();
    const aborted = p.goTo({ nodeId: "n3" }, { signal: ac.signal });
    ac.abort();
    const abortStatus = (await aborted).status;
    return {
      statuses,
      events,
      abortStatus,
      history: p.getState().history.map((v) => v.nodeId),
    };
  });
  expect(result.statuses).toEqual([...Array(9).fill("cancelled"), "completed"]);
  expect(result.history).toEqual(["n1", "n2"]);
  expect(result.abortStatus).toBe("cancelled");
  expect(result.events.slice(-2)).toEqual([
    "navigationstart",
    "navigationcancel",
  ]);
  await page.evaluate(() => {
    void window.demoPlayers[0]!.goTo({ nodeId: "n3" }, { durationMs: 60000 });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() => page.evaluate(() => window.demoPlayers[0]!.getState().status))
    .toBe("idle");
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().nodeId),
  ).toBe("n3");
});
test("50 mount/destroy cycles release listeners, RAF and observers; host content survives", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const originalAdd = EventTarget.prototype.addEventListener,
      originalRemove = EventTarget.prototype.removeEventListener,
      originalRequest = window.requestAnimationFrame,
      originalCancel = window.cancelAnimationFrame,
      OriginalObserver = window.ResizeObserver;
    const listeners: Array<{
        target: EventTarget;
        type: string;
        listener: EventListenerOrEventListenerObject | null;
      }> = [],
      frames = new Set<number>(),
      observers = new Set<ResizeObserver>();
    EventTarget.prototype.addEventListener = function (
      type,
      listener,
      options,
    ) {
      listeners.push({ target: this, type, listener });
      return originalAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (
      type,
      listener,
      options,
    ) {
      const i = listeners.findIndex(
        (v) => v.target === this && v.type === type && v.listener === listener,
      );
      if (i >= 0) listeners.splice(i, 1);
      return originalRemove.call(this, type, listener, options);
    };
    window.requestAnimationFrame = (callback) => {
      const id = originalRequest.call(window, (time) => {
        frames.delete(id);
        callback(time);
      });
      frames.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      frames.delete(id);
      originalCancel.call(window, id);
    };
    window.ResizeObserver = class extends OriginalObserver {
      override observe(target: Element, options?: ResizeObserverOptions) {
        observers.add(this);
        super.observe(target, options);
      }
      override disconnect() {
        observers.delete(this);
        super.disconnect();
      }
    };
    const host = document.createElement("div");
    host.tabIndex = 7;
    host.style.height = "400px";
    const preserved = document.createElement("span");
    preserved.textContent = "Host owned";
    host.append(preserved);
    document.body.append(host);
    let cancelled = 0,
      destroyEvents = 0,
      forbiddenReady = 0;
    try {
      for (let i = 0; i < 50; i++) {
        const p = window.createDemoPlayer();
        p.on("destroy", () => destroyEvents++);
        await p.mount(host, window.demoDocument);
        const pending = p.next();
        p.destroy();
        p.destroy();
        if ((await pending).status === "cancelled") cancelled++;
        p.on("ready", () => forbiddenReady++);
        const mounted = await p.mount(host, window.demoDocument);
        if (mounted.ok) throw Error("destroyed player remounted");
      }
      return {
        listeners: listeners.length,
        frames: frames.size,
        observers: observers.size,
        cancelled,
        destroyEvents,
        forbiddenReady,
        tabindex: host.getAttribute("tabindex"),
        children: host.children.length,
        text: preserved.textContent,
      };
    } finally {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
      window.requestAnimationFrame = originalRequest;
      window.cancelAnimationFrame = originalCancel;
      window.ResizeObserver = OriginalObserver;
      host.remove();
    }
  });
  expect(result).toEqual({
    listeners: 0,
    frames: 0,
    observers: 0,
    cancelled: 50,
    destroyEvents: 50,
    forbiddenReady: 0,
    tabindex: "7",
    children: 1,
    text: "Host owned",
  });
});
test("invalid mount is atomic; empty mount and throwing handlers remain usable", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.createElement("div");
    host.style.height = "400px";
    document.body.append(host);
    const p = window.createDemoPlayer();
    let diagnostics = 0;
    let ready = 0;
    p.on("diagnostic", () => {
      diagnostics++;
      throw Error("diagnostic sink");
    });
    p.on("scenechange", () => {
      throw Error("scene handler");
    });
    const off = p.on("ready", () => ready++);
    off();
    const invalid = await p.mount(host, {});
    const untouched =
      host.children.length === 0 && !host.hasAttribute("tabindex");
    const doc = structuredClone(window.demoDocument);
    doc.defaultPathId = null;
    const empty = await p.mount(host, doc);
    const emptyState = p.getState().status;
    const again = await p.mount(host, doc);
    await p.setPath("main");
    p.destroy();
    host.remove();
    return {
      invalid: invalid.ok,
      untouched,
      empty: empty.ok,
      emptyState,
      again: again.ok,
      diagnostics,
      ready,
    };
  });
  expect(result).toEqual({
    invalid: false,
    untouched: true,
    empty: true,
    emptyState: "empty",
    again: false,
    diagnostics: 1,
    ready: 0,
  });
});
test("text is rendered inertly and player does not steal focus on mount", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const input = document.querySelector("input")!;
    input.focus();
    const host = document.createElement("div");
    document.body.append(host);
    const doc = structuredClone(window.demoDocument);
    if (doc.scenes[0]!.blocks[0]!.type !== "text")
      throw new Error("Expected text fixture");
    doc.scenes[0]!.blocks[0]!.data.text =
      '<img src=x onerror="window.hacked=true">';
    const p = window.createDemoPlayer();
    await p.mount(host, doc);
    const result = {
      focused: document.activeElement === input,
      images: host.querySelectorAll("img").length,
      text: host.querySelector(".xc-content p")!.textContent,
    };
    p.destroy();
    host.remove();
    return result;
  });
  expect(result).toEqual({
    focused: true,
    images: 0,
    text: '<img src=x onerror="window.hacked=true">',
  });
});
test("CSP without unsafe-eval and no required remote requests", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("pageerror", (error) => violations.push(error.message));
  await page.route("**/core", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      },
    });
  });
  const remote: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:4173"))
      remote.push(request.url());
  });
  await page.goto("/core");
  await expect(page.locator(".xc-player")).toHaveCount(2);
  expect(
    await page.evaluate(
      async () =>
        (await window.demoPlayers[0]!.goTo({ nodeId: "n3" }, { durationMs: 0 }))
          .status,
    ),
  ).toBe("completed");
  expect(violations).toEqual([]);
  expect(remote).toEqual([]);
});
test("CSS 3D unavailable falls back to a navigable outline", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = CSS.supports.bind(CSS);
    CSS.supports = ((property: string, value?: string) =>
      property === "transform-style"
        ? false
        : value === undefined
          ? original(property)
          : original(property, value)) as typeof CSS.supports;
  });
  await page.reload();
  const outline = page.locator("#player-1 .xc-outline");
  await expect(outline).toBeVisible();
  await outline.getByRole("button", { name: "Detail" }).click();
  expect(
    await page.evaluate(() => window.demoPlayers[0]!.getState().nodeId),
  ).toBe("n2");
  await expect(page.locator("#player-1 .xc-stage")).toBeHidden();
});
test("continued keyboard navigation preserves focus, while editing during animation keeps input focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#player-1").focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator('#player-1 [data-scene-id="detail"] h2'),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator('#player-1 [data-scene-id="end"] h2'),
  ).toBeFocused();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#player-1").focus();
  await page.evaluate(() => {
    void window.demoPlayers[0]!.goTo({ nodeId: "n1" }, { durationMs: 100 });
  });
  const input = page.getByRole("textbox", { name: "Test input 1" });
  await input.focus();
  await expect
    .poll(() => page.evaluate(() => window.demoPlayers[0]!.getState().nodeId))
    .toBe("n1");
  await expect(input).toBeFocused();
});
