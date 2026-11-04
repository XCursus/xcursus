// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateDocument } from "@xcursus/core";
import type { ProjectDocument } from "@xcursus/core";
import tilted from "../../../tests/fixtures/paint/tilted-section.json";
import wide from "../../../tests/fixtures/paint/wide-sections.json";
import { createPlayer } from "../src/index.js";
import type { Player } from "../src/index.js";
import { activeFirst, needsPaintOrder, paintOrder } from "../src/paint.js";

const load = (input: unknown): ProjectDocument => {
  const result = validateDocument(input);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
};
const supports = { gecko: true };
beforeAll(() => {
  Object.assign(window, {
    CSS: {
      supports: (property: string) =>
        property !== "-moz-appearance" || supports.gecko,
    },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});
const players: Player[] = [];
afterEach(() => {
  players.splice(0).forEach((p) => p.destroy());
  document.body.replaceChildren();
  supports.gecko = true;
});

describe("paint order of scene planes (Gecko 3D sorting)", () => {
  it("paints first the planes that cut the least of the others", () => {
    // The plane of the wall (z = 0) crosses the turned panel; the panel's
    // plane misses the wall: the panel goes first, so the wall never cuts it.
    const order = paintOrder(load(wide));
    expect(order.indexOf("panel")).toBeLessThan(order.indexOf("wall"));
    // The small turned scene would cut the large tilted section.
    const other = paintOrder(load(tilted));
    expect(other.indexOf("section")).toBeLessThan(other.indexOf("side"));
  });

  it("puts the scene being shown first and depends on the document only", () => {
    const doc = load(tilted);
    const order = paintOrder(doc);
    expect(activeFirst(order, "left")[0]).toBe("left");
    expect(activeFirst(order, "left").slice(1)).toEqual(
      order.filter((id) => id !== "left"),
    );
    expect(activeFirst(order, "unknown")).toEqual(order);
    expect(activeFirst(order, null)).toEqual(order);
    expect([...paintOrder(doc)].sort()).toEqual(
      doc.scenes.map((s) => s.id).sort(),
    );
  });

  it("smaller scenes follow by area beyond the planes compared pairwise", () => {
    const doc = load(tilted);
    const extra = Array.from({ length: 80 }, (_, i) => ({
      ...structuredClone(doc.scenes[0]!),
      id: `tile-${i}`,
      position: [i * 200, 5000, 0] as [number, number, number],
      size: [100 + i, 100] as [number, number],
    }));
    const many = load({
      ...doc,
      scenes: [...doc.scenes, ...extra],
    });
    const order = paintOrder(many);
    const tail = order.slice(64);
    const area = (id: string) => {
      const s = many.scenes.find((x) => x.id === id)!;
      return s.size[0] * s.size[1];
    };
    expect(tail.length).toBe(many.scenes.length - 64);
    for (let i = 1; i < tail.length; i++)
      expect(area(tail[i - 1]!)).toBeGreaterThanOrEqual(area(tail[i]!));
  });

  it("is applied as z-index only where the engine needs it", async () => {
    const doc = load(tilted);
    const mount = async () => {
      const host = document.createElement("div");
      document.body.append(host);
      const player = createPlayer();
      players.push(player);
      expect((await player.mount(host, doc)).ok).toBe(true);
      return { host, player };
    };
    expect(needsPaintOrder(window as Window & typeof globalThis)).toBe(true);
    const { host, player } = await mount();
    const rank = (id: string) =>
      Number(
        host.querySelector<HTMLElement>(`[data-scene-id="${id}"]`)!.style
          .zIndex,
      );
    // Mounted on the first node: that scene first, then the document order.
    const expected = activeFirst(paintOrder(doc), "side");
    expect(expected.map(rank)).toEqual(expected.map((_, i) => i));
    await player.goTo({ nodeId: "left" }, { durationMs: 0 });
    expect(rank("left")).toBe(0);
    expect(rank("section")).toBeGreaterThan(0);
    // Wrappers stay in document order: nothing is moved in the DOM.
    expect(
      [...host.querySelectorAll<HTMLElement>("[data-scene-id]")].map(
        (e) => e.dataset.sceneId,
      ),
    ).toEqual(doc.scenes.map((s) => s.id));
    // Other engines keep the document order untouched.
    supports.gecko = false;
    expect(needsPaintOrder(window as Window & typeof globalThis)).toBe(false);
    const other = await mount();
    expect(
      [...other.host.querySelectorAll<HTMLElement>("[data-scene-id]")].every(
        (e) => e.style.zIndex === "",
      ),
    ).toBe(true);
    expect(needsPaintOrder(undefined)).toBe(false);
  });
});
