// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  frameMatrix,
  updateCapabilities,
  validateDocument,
} from "@xcursus/core";
import type { Block, ProjectDocument } from "@xcursus/core";
import fixture from "../../../examples/content-gallery/project.json";
import legacy from "../../../examples/core-three-scenes/project.json";
import { RendererRegistry, createPlayer } from "../src/index.js";
import type { ContentContext, Player } from "../src/index.js";
beforeAll(() => {
  Object.assign(window, {
    CSS: { supports: () => true },
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
});
const valid = (doc: unknown): ProjectDocument => {
  const r = validateDocument(doc);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
};
/** First gallery scene as a canvas: visual order differs from array order. */
function canvas(): ProjectDocument {
  const doc = valid(fixture);
  const scene = doc.scenes[0]!;
  scene.layout = "canvas";
  scene.appearance = {
    variant: "card",
    background: "backdrop",
    titleVisible: false,
  };
  scene.blocks = [
    {
      id: "first",
      type: "text",
      data: { text: "Primo nell'ordine di lettura" },
      frame: { x: 400, y: 300, width: 300, height: 100, rotation: 0, z: 5 },
      style: {
        align: "end",
        verticalAlign: "center",
        size: "xl",
        color: "accent",
      },
    },
    {
      id: "second",
      type: "markdown",
      data: { source: "**Secondo**" },
      frame: { x: 20, y: 20, width: 240, height: 160, rotation: 30, z: -1 },
    },
  ];
  doc.theme.palette.push({ id: "ink", value: "#0a0b0c" });
  doc.theme.colors.text = "ink";
  doc.theme.fonts = { body: "atkinson-hyperlegible", heading: "system-serif" };
  doc.theme.typeScale = { body: 30, title: 50 };
  updateCapabilities(doc);
  return valid(doc);
}
function recording() {
  const contexts: ContentContext[] = [];
  let mounts = 0;
  const registry = new RendererRegistry();
  registry.register("markdown", () => ({
    mount(host, context) {
      mounts++;
      contexts.push(context);
      host.textContent = "rendered";
    },
    update(context) {
      contexts.push(context);
    },
    destroy() {},
  }));
  return { registry, contexts, mounts: () => mounts };
}
async function mount(doc: ProjectDocument, registry?: RendererRegistry) {
  const host = document.createElement("div");
  document.body.append(host);
  const player = createPlayer(registry ? { registry } : {});
  players.push(player);
  expect((await player.mount(host, doc)).ok).toBe(true);
  return { host, player };
}
const block = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
describe("canvas scenes", () => {
  it("positions blocks with the core frame matrix and keeps the DOM in array order", async () => {
    const doc = canvas();
    const { host } = await mount(doc, recording().registry);
    const content = host.querySelector<HTMLElement>(
      '.xc-scene[data-scene-id="text"] .xc-content',
    )!;
    expect(content.classList.contains("xc-layout-canvas")).toBe(true);
    expect(
      [...content.querySelectorAll<HTMLElement>("[data-block-id]")].map(
        (e) => e.dataset.blockId,
      ),
    ).toEqual(["first", "second"]);
    for (const b of doc.scenes[0]!.blocks) {
      const el = block(host, b.id);
      expect(el.classList.contains("xc-framed")).toBe(true);
      expect(el.style.width).toBe(`${b.frame!.width}px`);
      expect(el.style.height).toBe(`${b.frame!.height}px`);
      expect(el.style.zIndex).toBe(String(b.frame!.z));
      const numbers = el.style.transform
        .match(/^matrix\((.*)\)$/)![1]!
        .split(",")
        .map(Number);
      frameMatrix(b.frame!).forEach((n, i) =>
        expect(numbers[i]).toBeCloseTo(n, 9),
      );
    }
    const first = block(host, "first");
    expect([...first.classList].sort()).toEqual(
      [
        "xc-align-end",
        "xc-block",
        "xc-framed",
        "xc-size-xl",
        "xc-valign-center",
      ].sort(),
    );
    expect(first.style.color).toMatch(/#215baf|rgb\(33, 91, 175\)/);
  });
  it("hides the title from view but keeps it as the scene name", async () => {
    const { host } = await mount(canvas());
    const content = host.querySelector<HTMLElement>(
      '.xc-scene[data-scene-id="text"] .xc-content',
    )!;
    const title = content.querySelector("h2")!;
    expect(title.classList.contains("xc-title-hidden")).toBe(true);
    expect(title.textContent).toBe("TEXT");
    expect(content.getAttribute("aria-labelledby")).toBe(title.id);
    expect(content.tabIndex).toBe(-1);
    expect(content.style.getPropertyValue("--xc-scene-background")).toBe(
      "#e8edf4",
    );
    expect(host.querySelector(".xc-outline")!.textContent).toContain("TEXT");
  });
  it("applies theme tokens as validated custom properties and allowlisted fonts", async () => {
    const { host } = await mount(canvas());
    const root = host.querySelector<HTMLElement>(".xc-player")!;
    expect(root.style.getPropertyValue("--xc-text")).toBe("#0a0b0c");
    expect(root.style.getPropertyValue("--xc-accent")).toBe("#215baf");
    expect(root.style.getPropertyValue("--xc-size-body")).toBe("30px");
    expect(root.style.getPropertyValue("--xc-size-title")).toBe("50px");
    expect(root.style.getPropertyValue("--xc-font-body")).toContain(
      "XCursus Atkinson Hyperlegible",
    );
    expect(root.style.getPropertyValue("--xc-font-heading")).toContain("serif");
  });
  it("moves, resizes, rotates and restyles without remounting renderers", async () => {
    const rec = recording();
    let doc = canvas();
    const { host, player } = await mount(doc, rec.registry);
    const element = block(host, "second"),
      mounts = rec.mounts();
    const edit = (change: (b: Block) => void) => {
      doc = structuredClone(doc);
      change(doc.scenes[0]!.blocks[1]!);
      updateCapabilities(doc);
      return player.updateDocument(doc);
    };
    expect(
      (
        await edit((b) => {
          b.frame = { ...b.frame!, x: 50, width: 300, rotation: -45, z: 9 };
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await edit((b) => {
          b.style = { size: "xs", color: "text" };
        })
      ).ok,
    ).toBe(true);
    expect(block(host, "second")).toBe(element);
    expect(rec.mounts()).toBe(mounts);
    expect(element.style.width).toBe("300px");
    expect(element.style.zIndex).toBe("9");
    expect(element.classList.contains("xc-size-xs")).toBe(true);
    // Renderers only see content: no frame, no style.
    for (const context of rec.contexts) {
      expect(context.block).not.toHaveProperty("frame");
      expect(context.block).not.toHaveProperty("style");
    }
    // A data change still rebuilds exactly that block.
    await edit((b) => {
      if (b.type === "markdown") b.data.source = "*nuovo*";
    });
    expect(rec.mounts()).toBe(mounts + 1);
  });
  it("returns to flow by removing every frame property and class", async () => {
    let doc = canvas();
    const { host, player } = await mount(doc);
    doc = structuredClone(doc);
    const scene = doc.scenes[0]!;
    scene.layout = "flow";
    scene.appearance = {
      variant: "plain",
      background: null,
      titleVisible: true,
    };
    scene.blocks.forEach((b) => {
      delete b.frame;
      delete b.style;
    });
    updateCapabilities(doc);
    expect((await player.updateDocument(doc)).ok).toBe(true);
    const content = host.querySelector<HTMLElement>(
      '.xc-scene[data-scene-id="text"] .xc-content',
    )!;
    expect(content.classList.contains("xc-layout-canvas")).toBe(false);
    expect(content.classList.contains("xc-variant-plain")).toBe(true);
    expect(content.hasAttribute("tabindex")).toBe(false);
    expect(content.style.getPropertyValue("--xc-scene-background")).toBe("");
    for (const id of ["first", "second"]) {
      const el = block(host, id);
      expect(el.className).toBe("xc-block");
      expect(el.getAttribute("style") ?? "").toBe("");
    }
  });
  it("leaves migrated flow documents without frame or token markup", async () => {
    const { host } = await mount(valid(legacy));
    for (const el of host.querySelectorAll<HTMLElement>("[data-block-id]")) {
      expect(el.className).toBe("xc-block");
      expect(el.hasAttribute("style")).toBe(false);
    }
    for (const content of host.querySelectorAll<HTMLElement>(".xc-content")) {
      expect(content.className).toBe("xc-content");
      expect(content.style.getPropertyValue("--xc-scene-background")).toBe("");
    }
    const root = host.querySelector<HTMLElement>(".xc-player")!;
    expect(root.style.getPropertyValue("--xc-text")).toBe("#172035");
    expect(root.style.getPropertyValue("--xc-font-body")).toBe(
      "system-ui, sans-serif",
    );
    expect(root.style.getPropertyValue("--xc-size-body")).toBe("28px");
  });
});
