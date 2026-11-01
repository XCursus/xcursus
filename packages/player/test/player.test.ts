// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  planCapture,
  sampleCapture,
  validateDocument,
  viewMatrix,
} from "@xcursus/core";
import type { Block, ProjectDocument } from "@xcursus/core";
import fixture from "../../../examples/content-gallery/project.json";
import {
  RendererRegistry,
  createAssetResolver,
  createPlayer,
  defaultMessages,
  italianMessages,
} from "../src/index.js";
import type {
  AssetLease,
  AssetResolver,
  ContentRenderer,
  Player,
  PlayerMessages,
} from "../src/index.js";
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
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  URL.revokeObjectURL = () => {};
});
const players: Player[] = [];
afterEach(() => {
  players.splice(0).forEach((p) => p.destroy());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function gallery(): ProjectDocument {
  const result = validateDocument(fixture);
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}
function manualClock() {
  let time = 0,
    serial = 0;
  const queue = new Map<number, () => void>();
  return {
    now: () => time,
    request: (callback: () => void) => {
      queue.set(++serial, callback);
      return serial;
    },
    cancel: (id: number) => void queue.delete(id),
    advance(ms: number) {
      time += ms;
      const callbacks = [...queue.values()];
      queue.clear();
      callbacks.forEach((c) => c());
    },
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function harness() {
  const stats = {
    mounts: [] as string[],
    destroys: [] as string[],
    updates: 0,
    resolves: [] as string[],
    releases: [] as string[],
  };
  const registry = new RendererRegistry();
  const renderer = (): ContentRenderer => {
    const leases: AssetLease[] = [];
    let host: HTMLElement, id: string;
    return {
      mount(element, context) {
        host = element;
        id = context.block.id;
        stats.mounts.push(id);
        const rendered = element.ownerDocument.createElement("span");
        rendered.textContent = `Rendered ${context.block.type} ${id}`;
        host.append(rendered);
        const data = context.block.data as { assetId?: string };
        if (data.assetId && context.services.assets)
          void context.services.assets
            .resolve(data.assetId, context.signal)
            .then((lease) => {
              if (context.signal.aborted) lease.release();
              else leases.push(lease);
            })
            .catch(() => {});
      },
      update() {
        stats.updates++;
      },
      destroy() {
        stats.destroys.push(id);
        leases.splice(0).forEach((l) => l.release());
        host.replaceChildren();
      },
    };
  };
  for (const type of ["markdown", "html", "image", "audio", "video"] as const)
    registry.register(type, renderer);
  const assets: AssetResolver = {
    async resolve(assetId) {
      stats.resolves.push(assetId);
      return {
        url: `blob:${assetId}`,
        mime: "application/octet-stream",
        release: () => stats.releases.push(assetId),
      };
    },
  };
  return { stats, registry, assets };
}
async function mounted(
  doc: ProjectDocument,
  options: Parameters<typeof createPlayer>[0] = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const player = createPlayer(options);
  players.push(player);
  let instanceId = "";
  player.on("ready", (e) => (instanceId = e.instanceId));
  const result = await player.mount(host, doc);
  expect(result.ok).toBe(true);
  await flush();
  return { host, player, instanceId };
}
const blockElements = (host: HTMLElement) =>
  new Map(
    [...host.querySelectorAll<HTMLElement>("[data-block-id]")].map((e) => [
      e.dataset.blockId!,
      e,
    ]),
  );
function edit(doc: ProjectDocument, change: (d: ProjectDocument) => void) {
  const next = structuredClone(doc);
  change(next);
  return next;
}
function block(doc: ProjectDocument, sceneId: string) {
  return doc.scenes.find((s) => s.id === sceneId)!.blocks[0]! as Block & {
    data: Record<string, unknown>;
  };
}
describe("incremental updateDocument", () => {
  it("rebuilds only the changed block and resolves only its own assets", async () => {
    const { stats, registry, assets } = harness(),
      doc = gallery();
    const { host, player } = await mounted(doc, { registry, assets });
    const mounts = stats.mounts.length,
      resolves = stats.resolves.length;
    expect(stats.resolves.sort()).toEqual(["diagram", "motion", "tone"]);
    const elements = blockElements(host);
    const markdown = edit(doc, (d) => {
      block(d, "markdown").data.source = "## Cambiato";
    });
    expect((await player.updateDocument(markdown)).ok).toBe(true);
    await flush();
    expect(stats.mounts.slice(mounts)).toEqual(["markdown-block"]);
    expect(stats.destroys).toEqual(["markdown-block"]);
    expect(stats.resolves).toHaveLength(resolves);
    expect(stats.releases).toEqual([]);
    for (const [id, element] of elements)
      if (id !== "markdown-block")
        expect(host.querySelector(`[data-block-id="${id}"]`)).toBe(element);
    const image = edit(markdown, (d) => {
      block(d, "image").data.alt = "Nuova descrizione";
    });
    await player.updateDocument(image);
    await flush();
    expect(stats.mounts.slice(mounts)).toEqual([
      "markdown-block",
      "image-block",
    ]);
    expect(stats.resolves.slice(resolves)).toEqual(["diagram"]);
    expect(stats.releases).toEqual(["diagram"]);
    const metadata = edit(image, (d) => {
      d.assets.find((a) => a.id === "motion")!.path =
        "assets/motion/renamed.mp4";
    });
    await player.updateDocument(metadata);
    await flush();
    expect(stats.mounts.at(-1)).toBe("video-block");
    expect(stats.releases).toEqual(["diagram", "motion"]);
  });
  it("updates scene matrices, titles, sizes and visibility in place without remounting", async () => {
    const { stats, registry, assets } = harness(),
      doc = edit(gallery(), (d) =>
        d.scenes.push({ ...structuredClone(d.scenes[0]!), id: "spare" }),
      );
    const { host, player } = await mounted(doc, { registry, assets });
    const wrapper = host.querySelector<HTMLElement>('[data-scene-id="html"]')!,
      transform = wrapper.style.transform,
      mounts = stats.mounts.length;
    const next = edit(doc, (d) => {
      const scene = d.scenes.find((s) => s.id === "html")!;
      scene.title = "Nuovo titolo";
      scene.position = [10, 20, 30];
      scene.size = [500, 400];
      d.scenes.find((s) => s.id === "spare")!.visible = false;
    });
    expect((await player.updateDocument(next)).ok).toBe(true);
    await flush();
    expect(stats.mounts).toHaveLength(mounts);
    expect(host.querySelector('[data-scene-id="html"]')).toBe(wrapper);
    expect(wrapper.querySelector("h2")!.textContent).toBe("Nuovo titolo");
    expect(wrapper.style.transform).not.toBe(transform);
    expect(wrapper.querySelector<HTMLElement>(".xc-content")!.style.width).toBe(
      "500px",
    );
    expect(
      host.querySelector<HTMLElement>('[data-scene-id="spare"]')!.hidden,
    ).toBe(true);
  });
  it("identical updates remount nothing, resolve nothing and still emit documentchange", async () => {
    const { stats, registry, assets } = harness(),
      doc = gallery();
    const { player } = await mounted(doc, { registry, assets });
    const mounts = stats.mounts.length,
      resolves = stats.resolves.length;
    let changes = 0;
    player.on("documentchange", () => changes++);
    for (let i = 0; i < 20; i++)
      await player.updateDocument(i % 2 ? doc : structuredClone(doc));
    await flush();
    expect(changes).toBe(20);
    expect(stats.mounts).toHaveLength(mounts);
    expect(stats.resolves).toHaveLength(resolves);
    expect(stats.releases).toEqual([]);
  });
  it("keeps the event order, cancellation and history contract", async () => {
    const { registry, assets } = harness(),
      clock = manualClock(),
      doc = gallery();
    const { player } = await mounted(doc, { registry, assets, clock });
    const events: string[] = [];
    for (const name of [
      "navigationstart",
      "navigationcancel",
      "scenechange",
      "navigationend",
      "documentchange",
    ] as const)
      player.on(name, () => events.push(name));
    const pending = player.goTo({ nodeId: "html" }, { durationMs: 600 });
    clock.advance(100);
    const update = await player.updateDocument(
      edit(doc, (d) => {
        block(d, "markdown").data.source = "changed";
      }),
    );
    expect(update.ok).toBe(true);
    expect((await pending).status).toBe("cancelled");
    expect(events).toEqual([
      "navigationstart",
      "navigationcancel",
      "documentchange",
    ]);
    const state = player.getState();
    expect(state.history).toHaveLength(1);
    expect(state.nodeId).toBe("text");
    expect(state.transition).toBeNull();
    clock.advance(1000);
    expect(events).not.toContain("scenechange");
  });
  it("produces the same DOM as a fresh full mount after a sequence of edits", async () => {
    const { registry, assets } = harness();
    let doc = gallery();
    const incremental = await mounted(doc, { registry, assets });
    const steps: Array<(d: ProjectDocument) => void> = [
      (d) => void (d.scenes[1]!.title = "Rinominata"),
      (d) => void (d.scenes[2]!.position = [5, -5, 100]),
      (d) => d.scenes.reverse(),
      (d) => {
        d.scenes.push({
          ...structuredClone(d.scenes[0]!),
          id: "extra",
          title: "Extra",
          blocks: [
            { id: "x1", type: "text", data: { text: "uno" } },
            { id: "x2", type: "markdown", data: { source: "*due*" } },
            { id: "x3", type: "html", data: { source: "<p>tre</p>" } },
          ],
        });
      },
      (d) => d.scenes.find((s) => s.id === "extra")!.blocks.reverse(),
      (d) => {
        const extra = d.scenes.find((s) => s.id === "extra")!;
        extra.blocks.splice(1, 1);
        extra.blocks[0] = {
          id: extra.blocks[0]!.id,
          type: "markdown",
          data: { source: "ora markdown" },
        };
        extra.parentId = "html";
        d.requiredCapabilities = ["linear", "blocks", "structure"];
      },
      (d) => void (d.scenes.find((s) => s.id === "extra")!.visible = false),
      (d) => void (d.assets.find((a) => a.id === "diagram")!.byteLength = 284),
      (d) => void (d.metadata.language = "en"),
      (d) => (d.scenes = d.scenes.filter((s) => s.id !== "extra")),
    ];
    for (const [index, step] of steps.entries()) {
      doc = edit(doc, step);
      const result = await incremental.player.updateDocument(doc);
      expect([index, result.diagnostics]).toEqual([index, []]);
    }
    await flush();
    const fresh = await mounted(doc, harness());
    // Attribute order carries no meaning; serialize with sorted attributes.
    const canonical = (node: Node): string =>
      node.nodeType === Node.TEXT_NODE
        ? JSON.stringify(node.textContent)
        : node instanceof Element
          ? `<${node.tagName}${[...node.attributes]
              .map((a) => ` ${a.name}=${JSON.stringify(a.value)}`)
              .sort()
              .join("")}>${[...node.childNodes].map(canonical).join("")}</>`
          : "";
    const normalize = (host: HTMLElement, id: string) =>
      canonical(host.querySelector(".xc-player")!).split(id).join("ID");
    expect(normalize(incremental.host, incremental.instanceId)).toBe(
      normalize(fresh.host, fresh.instanceId),
    );
  });
  it("re-resolves an unchanged asset record only when the resolver's Blob changes", async () => {
    const svg = (fill: string) =>
      new Blob(
        [
          `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${fill}"/></svg>`,
        ],
        { type: "image/svg+xml" },
      );
    const first = svg("#000000"),
      second = svg("#ffffff");
    const doc = edit(gallery(), (d) => {
      const asset = d.assets.find((a) => a.id === "diagram")!;
      asset.byteLength = first.size;
      delete asset.sha256;
    });
    const { stats, registry } = harness();
    let blobs = new Map([["diagram", first]]);
    let resolver = createAssetResolver(doc.assets, blobs);
    const assets: AssetResolver = {
      resolve: (id, signal) => {
        stats.resolves.push(id);
        return resolver.resolve(id, signal);
      },
      revision: (id) => resolver.revision?.(id),
    };
    const { player } = await mounted(doc, { registry, assets });
    const count = () => stats.resolves.filter((id) => id === "diagram").length;
    expect(count()).toBe(1);
    resolver = createAssetResolver(doc.assets, new Map(blobs));
    await player.updateDocument(doc);
    await flush();
    expect(count()).toBe(1);
    blobs = new Map([["diagram", second]]);
    resolver = createAssetResolver(doc.assets, blobs);
    await player.updateDocument(doc);
    await flush();
    expect(count()).toBe(2);
    resolver = createAssetResolver(doc.assets, new Map());
    await player.updateDocument(doc);
    await flush();
    expect(count()).toBe(3);
  });
  it("retries a block whose renderer failed on the next update", async () => {
    const registry = new RendererRegistry();
    let fail = true,
      mounts = 0;
    registry.register("markdown", () => ({
      mount(host) {
        mounts++;
        if (fail) throw new Error("boom");
        host.textContent = "ok";
      },
      update() {},
      destroy() {},
    }));
    const doc = gallery();
    const { host, player } = await mounted(doc, { registry });
    const markdown = () =>
      host.querySelector('[data-block-id="markdown-block"]')!.textContent;
    expect(markdown()).toContain("boom");
    fail = false;
    await player.updateDocument(doc);
    expect(markdown()).toBe("ok");
    await player.updateDocument(doc);
    expect(mounts).toBe(2);
  });
});
describe("per-frame rendering", () => {
  it("only the camera changes while a transition runs", async () => {
    const { stats, registry, assets } = harness(),
      clock = manualClock();
    const { host, player } = await mounted(gallery(), {
      registry,
      assets,
      clock,
    });
    const pending = player.goTo({ nodeId: "html" }, { durationMs: 600 });
    clock.advance(16);
    await flush();
    const updates = stats.updates;
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(host, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    for (let i = 0; i < 10; i++) clock.advance(16);
    await flush();
    records.push(...observer.takeRecords());
    observer.disconnect();
    const unexpected = records.filter(
      (r) =>
        !(
          r.type === "attributes" &&
          r.attributeName === "style" &&
          (r.target as Element).classList.contains("xc-world")
        ),
    );
    expect(
      unexpected.map(
        (r) =>
          `${r.type}:${(r.target as Element).className ?? ""}:${r.attributeName ?? ""}`,
      ),
    ).toEqual([]);
    expect(records.length).toBeGreaterThan(0);
    expect(stats.updates).toBe(updates);
    clock.advance(1000);
    expect((await pending).status).toBe("completed");
    expect(stats.updates).toBeGreaterThan(updates);
  });
});
describe("messages, language and outline", () => {
  const english: PlayerMessages = {
    ...defaultMessages,
    lang: "en",
    presentation: "Presentation",
    outline: "Text view",
    reduceMotion: "Reduce motion",
    overview: "Overview",
    camera: "Camera",
    sceneView: "Scene view",
    panLeft: "Pan left",
    panRight: "Pan right",
    panUp: "Pan up",
    panDown: "Pan down",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    enableMedia: "Enable media",
    stage: "Spatial presentation",
    emptyPath: "No scene in the selected path.",
    emptyPresentation: "Empty presentation",
    choices: "Path choices",
    choicePrompt: "Choose the path",
    choiceDisabled: (label, reason) => `${label} (${reason})`,
    visitLimit: (limit, target) =>
      `limit of ${limit} visits reached for ${target}`,
    contentUnavailable: (type) => `Content unavailable (${type})`,
    contentError: (detail) => `Content error: ${detail}`,
    pluginContent: (id) => `Plugin ${id}`,
  };
  it("replaces every player control string and applies document and UI languages", async () => {
    const doc = edit(gallery(), (d) => void (d.metadata.language = "en-GB"));
    const { host, player } = await mounted(doc, { messages: english });
    const root = host.querySelector<HTMLElement>(".xc-player")!;
    expect(root.lang).toBe("en-GB");
    expect(host.querySelector<HTMLElement>(".xc-access")!.lang).toBe("en");
    const chrome = [
      ...host.querySelectorAll(".xc-access, .xc-empty, .xc-choices"),
    ]
      .map((e) => e.textContent)
      .join(" ");
    const labels = [...host.querySelectorAll("[aria-label]")]
      .filter((e) => !e.closest(".xc-world") && e !== root)
      .map((e) => e.getAttribute("aria-label"))
      .join(" ");
    for (const [key, italian] of Object.entries(defaultMessages)) {
      if (
        typeof italian !== "string" ||
        italian === english[key as keyof PlayerMessages]
      )
        continue;
      expect(chrome).not.toContain(italian);
      expect(labels).not.toContain(italian);
    }
    expect(chrome).toContain("Text view");
    expect(chrome).toContain("Enable media");
    expect(
      host.querySelector('[data-block-id="markdown-block"]')!.textContent,
    ).toBe("Content unavailable (markdown)");
    await player.updateDocument(
      edit(doc, (d) => void (d.metadata.language = "fr")),
    );
    expect(root.lang).toBe("fr");
    const withEmpty = edit(doc, (d) => {
      d.paths.push({
        id: "empty",
        name: "Empty",
        startNodeId: null,
        nodes: [],
        edges: [],
      });
    });
    expect((await player.updateDocument(withEmpty)).ok).toBe(true);
    expect((await player.setPath("empty")).status).toBe("completed");
    expect(host.querySelector(".xc-empty")!.textContent).toBe(
      "No scene in the selected path.",
    );
    expect(host.querySelector(".xc-live")!.textContent).toBe(
      "Empty presentation",
    );
  });
  it("renders choice prompts and disabled reasons through messages", async () => {
    const doc = edit(gallery(), (d) => {
      const path = d.paths[0]!;
      path.loopPolicy = { maxVisitsPerNode: 1 };
      path.edges.push(
        {
          id: "back",
          from: "text",
          to: "text",
          label: "Again",
          condition: { kind: "manual" },
          transition: { durationMs: 0, easing: "linear" },
        },
        {
          id: "jump",
          from: "text",
          to: "html",
          label: "Jump",
          condition: { kind: "manual" },
          transition: { durationMs: 0, easing: "linear" },
        },
      );
      d.requiredCapabilities = ["linear", "blocks", "structure"];
    });
    const { host } = await mounted(doc, { messages: english });
    const choices = host.querySelector(".xc-choices")!;
    expect(choices.textContent).toContain("Choose the path");
    // The destination is named by its scene title, not its node ID.
    expect(choices.textContent).toContain(
      "Again (limit of 1 visits reached for TEXT)",
    );
    expect(choices.textContent).not.toContain("Limit");
  });
  it("outline shows derived text, never Markdown or HTML source", async () => {
    const { registry, assets } = harness();
    const doc = edit(gallery(), (d) => {
      block(d, "html").data.source = "<p>Ciao <em>mondo</em></p>";
    });
    const rendered = await mounted(doc, { registry, assets });
    const bare = await mounted(doc);
    for (const { host } of [rendered, bare]) {
      const outline = host.querySelector(".xc-outline")!.textContent!;
      expect(outline).not.toContain("**");
      expect(outline).not.toContain("<p>");
      expect(outline).not.toContain("<svg");
      expect(outline).not.toContain("\\int");
      expect(outline).toContain("Rectangle with a blue to pink gradient");
    }
    const outline = rendered.host.querySelector(".xc-outline")!.textContent!;
    expect(outline).toContain("Rendered markdown markdown-block");
    expect(outline).toContain("Rendered html html-block");
  });
});
describe("message defaults and overrides", () => {
  it("every default is plain text and functions interpolate their arguments", () => {
    for (const set of [defaultMessages, italianMessages])
      for (const [key, value] of Object.entries(set)) {
        const text =
          typeof value === "function"
            ? (value as (...a: unknown[]) => string)("A", "signature")
            : value;
        expect(typeof text, key).toBe("string");
        expect(text.length, key).toBeGreaterThan(0);
      }
    expect(Object.keys(italianMessages).sort()).toEqual(
      Object.keys(defaultMessages).sort(),
    );
  });
  it("defaults are English since 0.6; the former Italian set stays exported", () => {
    expect(defaultMessages.lang).toBe("en");
    expect(defaultMessages.outline).toBe("Text view");
    expect(defaultMessages.assetInvalid("x", "size")).toContain("size");
    expect(defaultMessages.visitLimit(3, "n")).toBe(
      "Limit of 3 visits reached for n",
    );
    expect(defaultMessages.visitLimit(1, "Intro")).toBe(
      "Limit of 1 visit reached for Intro",
    );
    expect(italianMessages.lang).toBe("it");
    expect(italianMessages.outline).toBe("Vista testuale");
    expect(italianMessages.assetInvalid("x", "size")).toContain("dimensione");
    expect(italianMessages.assetInvalid("x", "digest")).toContain("Digest");
    expect(italianMessages.visitLimit(3, "n")).toBe(
      "Limite di 3 visite raggiunto per n",
    );
    expect(italianMessages.visitLimit(1, "Intro")).toBe(
      "Limite di 1 visita raggiunto per Intro",
    );
  });
  it("ignores unknown keys, prototype keys and values of the wrong type", async () => {
    const overrides = JSON.parse(
      '{"__proto__":{"polluted":true},"outline":42,"unknown":"x","overview":"Overview"}',
    ) as Partial<PlayerMessages>;
    const { host } = await mounted(gallery(), {
      // JavaScript hosts can pass undefined values despite the type.
      messages: {
        ...overrides,
        enableMedia: undefined,
      } as unknown as Partial<PlayerMessages>,
    });
    const controls = host.querySelector(".xc-access")!.textContent!;
    expect(controls).toContain(defaultMessages.outline);
    expect(controls).toContain("Overview");
    expect(controls).toContain(defaultMessages.enableMedia);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
describe("capture clock and public data (0.6)", () => {
  const plan = (doc: ProjectDocument) => {
    const result = planCapture(
      doc,
      {
        pathId: doc.paths[0]!.id,
        visits: doc.paths[0]!.nodes.slice(0, 3).map((n) => ({ nodeId: n.id })),
      },
      { reducedMotion: false },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return result.value;
  };
  it("renderAt samples the plan with the core sampler, without visits, events or cues", async () => {
    const doc = edit(gallery(), (d) => {
      for (const n of d.paths[0]!.nodes) n.holdMs = 500;
    });
    const { host, player } = await mounted(doc);
    const events: string[] = [];
    for (const name of [
      "navigationstart",
      "navigationend",
      "scenechange",
      "cue",
    ] as const)
      player.on(name, () => events.push(name));
    const before = player.getState();
    const p = plan(doc);
    const world = host.querySelector<HTMLElement>(".xc-world")!;
    const t = p.visits[0]!.transition!.startMs + 100;
    expect((await player.renderAt(p, t)).ok).toBe(true);
    const sample = sampleCapture(p, t);
    expect(world.style.transform).toBe(
      `matrix3d(${viewMatrix(sample.camera).join(",")})`,
    );
    const active = host.querySelector<HTMLElement>(
      `[data-scene-id="${sample.sceneId}"]`,
    )!;
    expect(active.dataset.active).toBe("true");
    expect((await player.renderAt(p, p.visits[1]!.arrivalMs)).ok).toBe(true);
    expect(
      host.querySelector<HTMLElement>(
        `[data-scene-id="${p.visits[1]!.sceneId}"]`,
      )!.dataset.active,
    ).toBe("true");
    expect(events).toEqual([]);
    expect(player.getState().history).toEqual(before.history);
    // A navigation command leaves capture and resumes the machine state.
    await player.goTo({ nodeId: before.nodeId! }, { durationMs: 0 });
    expect(world.style.transform).toBe(
      `matrix3d(${viewMatrix(player.getState().camera!).join(",")})`,
    );
  });
  it("renderAt refuses a plan for another document, a time outside it and a busy player", async () => {
    const doc = gallery();
    const clock = manualClock();
    const { player } = await mounted(doc, { clock });
    const p = plan(doc);
    expect(
      (await player.renderAt({ ...p, documentId: "other" }, 0)).diagnostics[0]!
        .code,
    ).toBe("CAPTURE_PLAN_MISMATCH");
    expect((await player.renderAt(p, p.totalMs + 1)).diagnostics[0]!.code).toBe(
      "INVALID_CAPTURE_TIME",
    );
    void player.goTo(
      { nodeId: doc.paths[0]!.nodes[1]!.id },
      { durationMs: 500 },
    );
    expect((await player.renderAt(p, 0)).diagnostics[0]!.code).toBe(
      "CAPTURE_BUSY",
    );
    clock.advance(10000);
  });
  it("renderAt waits for renderer readiness", async () => {
    const registry = new RendererRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let settled = false;
    registry.register("markdown", () => ({
      mount() {},
      update() {},
      destroy() {},
      ready: () => gate,
    }));
    const doc = gallery();
    const { player } = await mounted(doc, { registry });
    const rendering = player.renderAt(plan(doc), 0).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    expect(settled).toBe(false);
    release();
    expect((await rendering).ok).toBe(true);
  });
  it("renderers and plugins receive the document without private notes", async () => {
    const registry = new RendererRegistry();
    const seen: string[] = [];
    registry.register("markdown", () => ({
      mount(_host, context) {
        seen.push(...context.document.scenes.map((s) => s.notes));
      },
      update(context) {
        seen.push(...context.document.scenes.map((s) => s.notes));
      },
      destroy() {},
    }));
    const doc = edit(gallery(), (d) => {
      for (const s of d.scenes) s.notes = `PRIVATE ${s.id}`;
    });
    const { host, player } = await mounted(doc, { registry });
    await player.updateDocument(
      edit(doc, (d) => void (d.metadata.title = "Changed")),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === "")).toBe(true);
    expect(host.innerHTML).not.toContain("PRIVATE");
  });
  it("controls: false leaves only the stage for capture pages", async () => {
    const { host } = await mounted(gallery(), { controls: false });
    expect(host.querySelector<HTMLElement>(".xc-access")!.hidden).toBe(true);
    expect(host.querySelector(".xc-choices")).toBeNull();
    expect(host.querySelector<HTMLElement>(".xc-stage")!.style.top).toBe("0px");
  });
});
